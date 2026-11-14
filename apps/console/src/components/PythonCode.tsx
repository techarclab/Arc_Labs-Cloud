/**
 * "Here is your script" for Raspberry Pi and other Linux boards: a complete Python 3 program (paho-mqtt) made from
 * the channel's fields. The Linux counterpart of ArduinoCodePanel.
 */
import { Device } from '../api';
import { pythonScript } from '../pythonScript';
import { useChannelFields } from './ArduinoCode';
import { CopyButton } from './ui';

export function PythonCodePanel({ device, token, onCopied }: { device: Device; token?: string; onCopied?: () => void }) {
  const { fields, channelName } = useChannelFields(device.projectId);
  const conn = device.connection;
  if (!fields || !conn) return <p className="muted">Preparing the script…</p>;
  const code = pythonScript({ device, channelName, fields, token, host: conn.mqttHost, port: conn.mqttPort, topicBase: conn.topicBase });
  const file = 'arc_cloud.py';

  return (
    <>
      <p>
        A complete Python 3 program for your Raspberry Pi, made from this channel’s fields: sensor fields are sent every {Math.max(5, device.expectedIntervalSeconds || 15)} s
        and each control gets a handler. Install the MQTT library with <code>sudo apt install -y python3-paho-mqtt</code>, fill in the lines marked{' '}
        <code>TODO</code>, then run <code>python3 {file}</code>.
      </p>
      <p className="small muted">
        {token
          ? 'This script contains the device key. Keep it private: run chmod 600 on it, and don’t share it or commit it to GitHub.'
          : 'Paste the device key (arc_dk_…) you saved when the device was added. Lost it? “New device key” gives a new one (the old one stops working).'}
      </p>
      <pre className="code sketch" style={{ maxHeight: 420 }} aria-label="Python script">
        {code}
      </pre>
      <div className="row">
        <span onClick={onCopied}>
          <CopyButton text={code} label="Copy script" />
        </span>
        <button
          className="btn"
          type="button"
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([code], { type: 'text/x-python' }));
            a.download = file;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            onCopied?.();
          }}
        >
          Download {file}
        </button>
      </div>
    </>
  );
}
