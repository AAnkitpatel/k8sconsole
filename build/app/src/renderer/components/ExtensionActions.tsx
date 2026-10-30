import { appliesTo, renderCommand, renderLink, type PlaceholderValues } from '../../shared/extensions';
import { call } from '../lib/api';
import { useCommandBridge } from '../lib/commandBridge';
import { useLoad } from '../ecs/common';

/** Buttons added by enabled extensions for one object: commands go into the terminal, links open in the browser. */
export function ExtensionActions({ kind, values }: { kind: string; values: PlaceholderValues }) {
  const ext = useLoad(() => call('extensions:list'), []);
  const { insertCommand } = useCommandBridge();
  const enabled = (ext.data?.installed ?? []).filter((e) => e.enabled).map((e) => e.manifest);
  const commands = enabled.flatMap((m) => m.commands.filter((c) => appliesTo(c.kinds, kind)).map((c) => ({ m, c, text: renderCommand(c.command, { ...values, kind: values.kind ?? kind.toLowerCase() }) })));
  const links = enabled.flatMap((m) => m.links.filter((l) => appliesTo(l.kinds, kind)).map((l) => ({ m, l, url: renderLink(l.url, { ...values, kind: values.kind ?? kind }) })));
  if (!commands.length && !links.length) return null;
  return (
    <span className="ext-actions" data-testid="extension-actions">
      {commands.map(({ m, c, text }) => (
        <button
          key={`${m.id}/${c.id}`}
          className="btn btn-sm"
          disabled={!text}
          title={text ? `${m.name}: types "${text}" into a new terminal (you press Enter to run it)` : `${m.name}: not available for this object`}
          onClick={() => text && insertCommand(text, c.title)}
          data-testid="extension-command"
        >
          ⌘ {c.title}
        </button>
      ))}
      {links.map(({ m, l, url }) => (
        <button key={`${m.id}/${l.id}`} className="btn btn-sm" disabled={!url} title={url ? `${m.name}: opens ${new URL(url).host}` : `${m.name}: not available`} onClick={() => url && void call('app:openExternal', url)} data-testid="extension-link">
          ↗ {l.title}
        </button>
      ))}
    </span>
  );
}
