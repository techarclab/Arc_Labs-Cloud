/**
 * Minimal C/C++ (Arduino) syntax colouring: comments, strings, preprocessor lines, numbers, keywords, calls.
 * Builds React elements (no HTML injection), so it is safe for any text, including generated device names.
 */
import { ReactNode } from 'react';

const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*")|(^[ \t]*#[a-z]+)|(\b\d+(?:\.\d+)?(?:UL|L|f)?\b)|(\b(?:void|float|int|bool|const|char|unsigned|long|return|if|else|for|while|true|false|HIGH|LOW|INPUT|OUTPUT|NAN|nullptr|auto)\b)|(\b[A-Za-z_]\w*(?=\s*\())/gm;
const CLASS = ['', 'tk-com', 'tk-str', 'tk-pre', 'tk-num', 'tk-kw', 'tk-fn'];

export function highlightCpp(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of code.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(code.slice(last, i));
    const group = m.findIndex((g, n) => n > 0 && g !== undefined);
    out.push(
      <span key={key++} className={CLASS[group]}>
        {m[0]}
      </span>,
    );
    last = i + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

export function CppBlock({ code, maxHeight = 420 }: { code: string; maxHeight?: number }) {
  return (
    <pre className="code sketch" style={{ maxHeight }} aria-label="Arduino sketch">
      {highlightCpp(code)}
    </pre>
  );
}
