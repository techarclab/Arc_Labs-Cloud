/**
 * Blynk-style "here is your sketch": a complete Arduino sketch for the ArcCloud library, generated from the
 * channel's fields (sensor fields become add() lines, control fields become onControl() handlers).
 * Two variants: the token in the sketch (quick start) or no secrets (credentials pasted over USB).
 */
import { useEffect, useState } from 'react';
import { api, Device, MetricDef } from '../api';
import { arduinoSketch } from '../arduinoSketch';
import { CopyButton } from './ui';
import { CppBlock } from './CodeHighlight';

export function useLibraryDownload() {
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => {
    fetch('/downloads/arduino-library.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.file && setFile(`/downloads/${j.file}`))
      .catch(() => undefined);
  }, []);
  return file;
}

/** The channel's fields and name, which the generated code is made from. */
export function useChannelFields(projectId: string) {
  const [fields, setFields] = useState<MetricDef[] | null>(null);
  const [channelName, setChannelName] = useState<string | undefined>();
  useEffect(() => {
    api<{ items: MetricDef[] }>('GET', `/projects/${projectId}/metric-definitions`)
      .then((r) => setFields(r.items))
      .catch(() => setFields([]));
    api<{ name: string }>('GET', `/projects/${projectId}`)
      .then((p) => setChannelName(p.name))
      .catch(() => undefined);
  }, [projectId]);
  return { fields, channelName };
}

/** The generator UI, used in the "device registered" dialog (with the real token) and on the device page (without). */
export function ArduinoCodePanel({ device, token, onCopied }: { device: Device; token?: string; onCopied?: () => void }) {
  const { fields, channelName } = useChannelFields(device.projectId);
  const [provisioned, setProvisioned] = useState(false);
  const library = useLibraryDownload();

  const conn = device.connection;
  if (!fields || !conn) return <p className="muted">Preparing the sketch…</p>;
  const code = arduinoSketch({ device, channelName, fields, token, provisioned, host: conn.mqttHost, port: conn.mqttPort, topicBase: conn.topicBase });
  const file = `${device.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'arc_device'}.ino`;

  return (
    <>
      <p>
        A complete sketch for the <b>ArcCloud</b> Arduino library, made from this channel’s fields: sensor fields are sent every {Math.max(5, device.expectedIntervalSeconds || 15)} s and
        each control gets a handler. Fill in the lines marked <code>TODO</code>.{' '}
        {library ? (
          <a href={library} download>
            Download the ArcCloud library (.zip)
          </a>
        ) : (
          'The library zip is on the console’s downloads page.'
        )}{' '}
        and install it with <i>Sketch → Include Library → Add .ZIP Library…</i>
      </p>
      <div className="seg" role="group" aria-label="Where the device key lives">
        <button type="button" aria-pressed={!provisioned} onClick={() => setProvisioned(false)}>
          Key in the sketch (quick start)
        </button>
        <button type="button" aria-pressed={provisioned} onClick={() => setProvisioned(true)}>
          No secrets in the sketch
        </button>
      </div>
      <p className="small muted">
        {provisioned
          ? 'Recommended for anything shared or updated over the air: the token is pasted once over USB and kept in the board’s flash.'
          : token
            ? 'This sketch contains the device key. Keep it private: don’t share it, commit it to GitHub, or host the compiled file.'
            : 'Paste the device key (arc_dk_…) you saved when the device was added. Lost it? “New device key” gives a new one (the old one stops working).'}
      </p>
      <CppBlock code={code} />
      <div className="row">
        <span onClick={onCopied}>
          <CopyButton text={code} label="Copy sketch" />
        </span>
        <button
          className="btn"
          type="button"
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([code], { type: 'text/plain' }));
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
