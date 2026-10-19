import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { yaml } from '@codemirror/lang-yaml';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { validateManifest } from '../../shared/validation';

export interface YamlEditorProps {
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  dark: boolean;
  /** Validate as a Kubernetes manifest (default true). */
  manifest?: boolean;
  /** Edit JSON instead of YAML (syntax highlighting and parse errors). */
  language?: 'yaml' | 'json';
}

/** Reports the first JSON syntax error at its position. */
const jsonLinter = linter((view) => {
  const text = view.state.doc.toString();
  if (!text.trim()) return [];
  try {
    JSON.parse(text);
    return [];
  } catch (err) {
    const msg = (err as Error).message;
    const m = /position (\d+)/.exec(msg) ?? /column (\d+)/.exec(msg);
    const pos = m ? Math.min(Number(m[1]), text.length) : 0;
    return [{ from: Math.max(0, pos - 1), to: Math.min(text.length, pos + 1), severity: 'error' as const, message: msg }];
  }
});

const manifestLinter = linter((view) => {
  const text = view.state.doc.toString();
  const v = validateManifest(text);
  const diags: Diagnostic[] = [];
  for (const issue of v.issues) {
    const lineNo = Math.min(Math.max(issue.line ?? 1, 1), view.state.doc.lines);
    const line = view.state.doc.line(lineNo);
    diags.push({ from: line.from, to: line.to, severity: issue.severity, message: issue.message });
  }
  return diags;
});

export function YamlEditor({ value, onChange, readOnly, dark, manifest = true, language = 'yaml' }: YamlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const theme = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        language === 'json' ? json() : yaml(),
        theme.current.of(dark ? oneDark : []),
        EditorState.readOnly.of(!!readOnly),
        EditorView.editable.of(!readOnly),
        ...(language === 'json' ? (readOnly ? [] : [lintGutter(), jsonLinter]) : manifest && !readOnly ? [lintGutter(), manifestLinter] : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
        }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current! });
    return () => view.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, manifest, language]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: theme.current.reconfigure(dark ? oneDark : []) });
  }, [dark]);

  return <div className="yaml-editor" ref={host} data-testid="yaml-editor" />;
}
