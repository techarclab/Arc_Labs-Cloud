// Copy to config.h and fill in. Never commit config.h (it holds this device's secret).
#pragma once

#define WIFI_SSID      "your-wifi"
#define WIFI_PASSWORD  "your-wifi-password"

// From the POST /api/v1/devices response → credentials
#define MQTT_HOST        "arc-cloud-mqtt-88efed08bd21b8f3.elb.ap-southeast-1.amazonaws.com"
#define MQTT_PORT        8883
#define DEVICE_ID        "00000000-0000-0000-0000-000000000000"
#define DEVICE_PASSWORD  "paste-the-one-time-password"
#define TOPIC_TELEMETRY  "arc/v1/<orgId>/<projectId>/<deviceId>/telemetry"
#define TOPIC_STATE      "arc/v1/<orgId>/<projectId>/<deviceId>/state"
#define TOPIC_COMMANDS   "arc/v1/<orgId>/<projectId>/<deviceId>/cmd"
#define TOPIC_ACK        "arc/v1/<orgId>/<projectId>/<deviceId>/cmd-ack"

#define FIRMWARE_VERSION "1.0.0"
#define PUBLISH_INTERVAL_MS 10000   // keep in line with the device's expectedIntervalSeconds

// AWS MQTT CA certificate from infra/certs/aws/ca.crt.
static const char CA_CERT[] = R"PEM(
-----BEGIN CERTIFICATE-----
MIIFITCCAwmgAwIBAgIUTmynZAnzM8ZkXHd4bjiUOek+YgIwDQYJKoZIhvcNAQEL
BQAwIDEeMBwGA1UEAwwVQVJDIENsb3VkIEFXUyBNUVRUIENBMB4XDTI2MTAxNjA1
Mjc1MVoXDTM2MTAxMzA1Mjc1MVowIDEeMBwGA1UEAwwVQVJDIENsb3VkIEFXUyBN
UVRUIENBMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAxORMsPviKBrR
oc2JO1v6QJJfFuZTcjphXv5aIZfSCJpw+AloSIuxL4f0YkEMzC12PCHSR26V4uuT
CA1evQkx6+wEvIY3Cpli7KBpRAnEpMiY62BcOCqcfqmY5tbrMnUQm+9kt+YPo2U9
mboTSIdmVB/KC28NBks+/QDUxkmmZ/coHph5j0Qnf4EOvdKA1XuAlu6OJtbhoSoj
zFqoRF+Io3Mdm8IHeYho6pslrWoyp/XZcFzU8WVBsCbMzqYmwtN8oYFkgJrmqfLE
2mlWQHaYr5ucRoNWSjt7UGkkyt2pXbpfUNJ+1IS0e901ZK4/xnNYs1zmoELOhmLC
I+RS58lu/vLhWDXMu7sJXsEqqv0UFyPrdj3BZxUp4CfN/tSAB38KVTAtZdu7LvkG
DN+HmsRw2dBdKWtKhIvJ7LNlw2ZmA2ZbzSURIssF0kOxJ7SEMR3apeoxj8s4k75I
TtCWwp8IPbOUemau/PMH1mf9yH//CT9oUFfgSORugblGYU2Mgoh6/mg/jqzpqm1P
j1cXcDl9fDZA9sEoldj1J7XtHqe3JSqCE7oNwNM4imSUTX7uI4qxiaohgK1ILcQn
g13Z8Q7Qzfc9itL2ExyQ5W5+Gunid1FkZrIQpGKgoMIediXEoKDgg2LdZcSWLhcg
TP9+tguWLGqNiUbCA2C1rNm9DosHR0MCAwEAAaNTMFEwHQYDVR0OBBYEFA/YDZIy
4AiQ/m3T5UCm+5OybPagMB8GA1UdIwQYMBaAFA/YDZIy4AiQ/m3T5UCm+5OybPag
MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggIBALvJ6X3Xvg2LtD+Q
bUamdRUCEEBqo7ogsz/sxqTDCliEI1a2/2asAhhrwhcboxOd0E1WXE/5O6ysDkEm
FFMDCS1PORwsfk4z6YqFFbkD7H2gDvmnP8cDpIwys1Ig2Xt9rnraI8G2oxSATGeg
2m5jHOJ3LWvXYm3oL2mxtiQ1YzqbMjp0EaYMYzWjoT9uKT+2MODyefMuqAHiW4pw
g2ngweV7DqV/Hb5kD9UoKS46APZ5BDDgWZGaJvjPrsJwmeZTarxZAONZ/Veuc++b
7geqO8LEtFDbUj7pLZB39q9ZaX7ph2KD0g6NmWScNsD+UBwF0N5/V7kAqQ8Vf5a5
g+RghgD6u1AJoYuYQ8oacQ2WOLB8QAGQGIrOhZ34hMC+ZXJ14yQMx0inmc7m/pri
dGXKOeERZ0yWRcGHd6IqPD5JegeOC0Hn8EKuHf+b1jWdETP6seW4lWGsmRdcWXiX
BOPGFCHEMDM8ox4bjkBwQX8JuHOdGwcAbXpKootfArHe12Zp4uy5W/TCH20tKSn8
welYLopT9ZJ4p/HBu4WnwhMb7A9ewQYWxipjiBqWpCGZqQ0YmGBufLUFAJIWKpWH
MyQXR8zvCe4P0QM7FozwC0D3GIngNjtUFjeIQZ8731/4aHXwKzcjT65ZNB838LpO
VCdZaqOaDvw9bR0UCBjDaBkPeUkq
-----END CERTIFICATE-----
)PEM";
