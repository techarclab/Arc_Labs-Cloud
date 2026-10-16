param(
  [string]$Profile = 'arc-cloud-migration',
  [string]$Region = 'ap-southeast-1'
)

$ErrorActionPreference = 'Stop'
$stackName = 'arc-cloud-backend'
$outputsJson = aws cloudformation describe-stacks --stack-name $stackName --region $Region --profile $Profile --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not read the AWS stack outputs.' }
$outputs = ($outputsJson | ConvertFrom-Json).Stacks[0].Outputs
$mqttHost = ($outputs | Where-Object OutputKey -eq 'MqttHost').OutputValue
$secretArn = ($outputs | Where-Object OutputKey -eq 'MqttTlsSecretArn').OutputValue
if (-not $mqttHost -or -not $secretArn) { throw 'The stack outputs do not contain MqttHost and MqttTlsSecretArn.' }

$openssl = (Get-Command openssl.exe -ErrorAction SilentlyContinue).Source
if (-not $openssl) { $openssl = Join-Path $env:ProgramFiles 'Git\usr\bin\openssl.exe' }
if (-not (Test-Path -LiteralPath $openssl)) { throw 'OpenSSL is required. Install Git for Windows or OpenSSL and retry.' }

# Keep the CA signing key in the user's local profile, outside the repository.
$privateDir = Join-Path $env:LOCALAPPDATA 'ARCCloud\aws-mqtt-ca'
New-Item -ItemType Directory -Force -Path $privateDir | Out-Null
$caKey = Join-Path $privateDir 'ca.key'
$caCert = Join-Path $privateDir 'ca.crt'
$serverKey = Join-Path $privateDir 'server.key'
$serverCsr = Join-Path $privateDir 'server.csr'
$serverCert = Join-Path $privateDir 'server.crt'
$extensionFile = Join-Path $privateDir 'server-ext.cnf'
$secretFile = Join-Path $privateDir 'mqtt-tls-secret.json'

if (Test-Path -LiteralPath $caKey) {
  throw "A CA key already exists at $caKey. Reuse the existing certificate setup or move that key before creating a new CA."
}

& $openssl genrsa -out $caKey 4096
if ($LASTEXITCODE -ne 0) { throw 'Could not create the local MQTT CA key.' }
& $openssl req -x509 -new -nodes -key $caKey -sha256 -days 3650 -out $caCert -subj '/CN=ARC Cloud AWS MQTT CA'
if ($LASTEXITCODE -ne 0) { throw 'Could not create the local MQTT CA certificate.' }
& $openssl req -new -newkey rsa:2048 -nodes -keyout $serverKey -out $serverCsr -subj "/CN=$mqttHost"
if ($LASTEXITCODE -ne 0) { throw 'Could not create the MQTT server certificate request.' }

@"
[server_ext]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:$mqttHost
"@ | Set-Content -Encoding ascii -Path $extensionFile

& $openssl x509 -req -in $serverCsr -CA $caCert -CAkey $caKey -CAcreateserial -out $serverCert -days 365 -sha256 -extfile $extensionFile -extensions server_ext
if ($LASTEXITCODE -ne 0) { throw 'Could not sign the MQTT server certificate.' }

$secret = @{
  ca = [Convert]::ToBase64String([IO.File]::ReadAllBytes($caCert))
  cert = [Convert]::ToBase64String([IO.File]::ReadAllBytes($serverCert))
  key = [Convert]::ToBase64String([IO.File]::ReadAllBytes($serverKey))
} | ConvertTo-Json -Compress
[IO.File]::WriteAllText($secretFile, $secret, [System.Text.UTF8Encoding]::new($false))

aws secretsmanager put-secret-value --secret-id $secretArn --secret-string "file://$secretFile" --region $Region --profile $Profile --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not upload the MQTT TLS secret to Secrets Manager.' }

$publicCertDir = Join-Path $PSScriptRoot '..\..\infra\certs\aws'
New-Item -ItemType Directory -Force -Path $publicCertDir | Out-Null
Copy-Item -LiteralPath $caCert -Destination (Join-Path $publicCertDir 'ca.crt') -Force

aws ecs update-service --cluster arc-cloud --service emqx --desired-count 1 --force-new-deployment --region $Region --profile $Profile --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not start the EMQX service.' }
aws ecs wait services-stable --cluster arc-cloud --services emqx --region $Region --profile $Profile
if ($LASTEXITCODE -ne 0) { throw 'The EMQX service did not become stable. Check its CloudWatch logs.' }

aws ecs update-service --cluster arc-cloud --service worker --desired-count 1 --force-new-deployment --region $Region --profile $Profile --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not start the ingestion worker.' }
aws ecs wait services-stable --cluster arc-cloud --services worker --region $Region --profile $Profile
if ($LASTEXITCODE -ne 0) { throw 'The ingestion worker did not become stable. Check its CloudWatch logs.' }

Write-Host "EMQX and the ingestion worker are running. AWS MQTT endpoint: $mqttHost`:8883"
Write-Host "Public CA certificate for firmware: $(Join-Path $publicCertDir 'ca.crt')"
Write-Host "Keep the CA private key at $caKey private. Never copy it into firmware or Git."
