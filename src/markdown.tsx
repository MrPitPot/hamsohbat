import React, { useState } from 'react';
import { get, displayName, openModal, navigate, findChannel, syncRoute } from './store';
import { CustomEmoji } from './features/Messages';
import { lang, t } from './i18n';

const INLINE =
  /(`[^`\n]+`)|(\*\*[\s\S]+?\*\*)|(__[\s\S]+?__)|(~~[\s\S]+?~~)|(\|\|[\s\S]+?\|\|)|(\*[^*\n]+\*)|((?<![\p{L}\p{N}])_[^_\n]+_(?![\p{L}\p{N}]))|(<@\d+>)|(@everyone|@here)|(https?:\/\/[^\s<>]+)|(<a?:\w+:[0-9a-z]+>)|(<#\d+>)|(<@&\d+>)|(<t:-?\d+(?::[tTdDfFR])?>)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/gu;

function Spoiler({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={'spoiler' + (open ? ' open' : '')} onClick={() => setOpen(true)}>
      {children}
    </span>
  );
}

function inline(text: string, serverId: string | null | undefined, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const k = key + '-' + i++;
    const tok = m[0];
    const inner = (n: number) => inline(tok.slice(n, -n), serverId, k);
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inner(2)}</strong>);
    else if (m[3]) out.push(<u key={k}>{inner(2)}</u>);
    else if (m[4]) out.push(<s key={k}>{inner(2)}</s>);
    else if (m[5]) out.push(<Spoiler key={k}>{inner(2)}</Spoiler>);
    else if (m[6] || m[7]) out.push(<em key={k}>{inner(1)}</em>);
    else if (m[8]) {
      const id = tok.slice(2, -1);
      out.push(
        <span key={k} className="mention" onClick={(e) => get().users[id] && openModal('profile', { userId: id, serverId, anchor: e.currentTarget })}>
          @{displayName(id, serverId)}
        </span>
      );
    } else if (m[9])
      out.push(
        <span key={k} className="mention">
          {tok}
        </span>
      );
    else if (m[11]) out.push(<CustomEmoji key={k} token={tok} />);
    else if (m[12]) {
      const ch = findChannel(tok.slice(2, -1));
      out.push(
        <span key={k} className="mention channel-mention" onClick={() => ch && navigate(ch.serverId || null, ch.id)}>
          #{ch ? ch.name : t('unknown')}
        </span>
      );
    } else if (m[13]) {
      const sv = serverId ? get().servers[serverId] : null;
      const role = sv?.roles.find((r: any) => r.id === tok.slice(3, -1));
      out.push(
        <span key={k} className="mention" style={role?.color ? { color: role.color, background: role.color + '22' } : undefined}>
          @{role ? role.name : t('deleted-role')}
        </span>
      );
    } else if (m[14]) out.push(<Timestamp key={k} tok={tok} />);
    else if (m[15]) {
      const mm = tok.match(/^\[([^\]]+)\]\((.+)\)$/)!;
      out.push(
        <a key={k} href={mm[2]} target="_blank" rel="noopener noreferrer" title={mm[2]}>
          {inline(mm[1], serverId, k)}
        </a>
      );
    } else if (m[10]) {
      // Trailing punctuation is almost never part of the link.
      const url = tok.replace(/[.,!?;:)\]]+$/, '');
      const invite = url.match(new RegExp('^' + location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/invite/(\\w+)$'));
      out.push(
        <a
          key={k}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            // Links to this app (channels, messages) open in place.
            if (!invite && url.startsWith(location.origin + '/channels/')) {
              e.preventDefault();
              history.pushState(null, '', url.slice(location.origin.length));
              syncRoute();
              return;
            }
            if (!invite) return;
            e.preventDefault();
            openModal('join', { code: invite[1] });
          }}
        >
          {url}
        </a>
      );
      if (url.length < tok.length) out.push(tok.slice(url.length));
    }
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Discord's <t:unix:style> timestamps, shown in the reader's own time zone. */
function Timestamp({ tok }: { tok: string }) {
  const [, secs, style = 'f'] = tok.match(/^<t:(-?\d+)(?::(\w))?>$/)!;
  const d = new Date(Number(secs) * 1000);
  const loc = lang() === 'fa' ? 'fa-IR' : 'en-US';
  const h12 = !get().settings.clock24;
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(loc, { hour12: h12, ...o }).format(d);
  let text = '';
  if (style === 'R') {
    const diff = (d.getTime() - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' });
    const a = Math.abs(diff);
    text = a < 60 ? rtf.format(Math.round(diff), 'second') : a < 3600 ? rtf.format(Math.round(diff / 60), 'minute') : a < 86400 ? rtf.format(Math.round(diff / 3600), 'hour') : a < 2592000 ? rtf.format(Math.round(diff / 86400), 'day') : a < 31536000 ? rtf.format(Math.round(diff / 2592000), 'month') : rtf.format(Math.round(diff / 31536000), 'year');
  } else if (style === 't') text = f({ hour: '2-digit', minute: '2-digit' });
  else if (style === 'T') text = f({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
  else if (style === 'd') text = f({ year: 'numeric', month: '2-digit', day: '2-digit' });
  else if (style === 'D') text = f({ year: 'numeric', month: 'long', day: 'numeric' });
  else if (style === 'F') text = f({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  else text = f({ year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return (
    <span className="timestamp" title={f({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}>
      {text}
    </span>
  );
}

function blocks(text: string, serverId: string | null | undefined, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = text.split('\n');
  let buf: string[] = [];
  let quote: string[] = [];
  let list: string[] = [];
  const k = (p: string) => key + p + out.length;
  const flush = () => {
    if (buf.length) out.push(<React.Fragment key={k('p')}>{inline(buf.join('\n'), serverId, k('p'))}</React.Fragment>);
    buf = [];
  };
  const flushQuote = () => {
    if (quote.length) out.push(<blockquote key={k('q')}>{inline(quote.join('\n'), serverId, k('q'))}</blockquote>);
    quote = [];
  };
  const flushList = () => {
    if (list.length)
      out.push(
        <ul key={k('l')}>
          {list.map((item, i) => (
            <li key={i}>{inline(item, serverId, k('l') + i)}</li>
          ))}
        </ul>
      );
    list = [];
  };
  // Block elements end their own line, so the newline right after one is dropped.
  let afterBlock = false;
  for (const line of lines) {
    const heading = line.match(/^(#{1,3}) (.+)$/);
    const sub = line.match(/^-# (.+)$/);
    const item = line.match(/^\s*[-*] (.+)$/);
    if (line.startsWith('> ')) {
      flush();
      flushList();
      quote.push(line.slice(2));
    } else if (heading || sub) {
      flush();
      flushQuote();
      flushList();
      if (sub) out.push(<span key={k('s')} className="subtext">{inline(sub[1], serverId, k('s'))}</span>);
      else {
        const Tag = ('h' + heading![1].length) as 'h1';
        out.push(<Tag key={k('h')}>{inline(heading![2], serverId, k('h'))}</Tag>);
      }
      afterBlock = true;
      continue;
    } else if (item) {
      flush();
      flushQuote();
      list.push(item[1]);
    } else {
      const wasBlock = afterBlock || quote.length > 0 || list.length > 0;
      flushQuote();
      flushList();
      if (wasBlock && line === '' && !buf.length) {
        afterBlock = false;
        continue;
      }
      buf.push(line);
    }
    afterBlock = false;
  }
  flush();
  flushQuote();
  flushList();
  return out;
}

export function Markdown({ text, serverId }: { text: string; serverId?: string | null }) {
  const out: React.ReactNode[] = [];
  const parts = text.split(/```(?:[a-zA-Z0-9+#-]*\n)?([\s\S]*?)```/g);
  parts.forEach((part, i) => {
    if (i % 2)
      out.push(
        <pre key={i}>
          <code>{part.replace(/\n$/, '')}</code>
        </pre>
      );
    else if (part) out.push(...blocks(i > 0 ? part.replace(/^\n/, '') : part, serverId, String(i)));
  });
  return <>{out}</>;
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;
export const isJumbo = (text: string) => {
  const rest = text.replace(/<a?:\w+:[0-9a-z]+>/g, '');
  const customs = (text.match(/<a?:\w+:[0-9a-z]+>/g) || []).length;
  if (customs && customs <= 27 && (!rest.trim() || (EMOJI_ONLY.test(rest) && rest.length <= 40))) return true;
  return text.length <= 40 && EMOJI_ONLY.test(text) && /\p{Extended_Pictographic}/u.test(text);
};

/** Plain one-line preview of a message (for replies, notifications and pins). */
export function plain(text: string, serverId?: string | null) {
  return text
    .replace(/<@(\d+)>/g, (_, id) => '@' + displayName(id, serverId))
    .replace(/<a?:(\w+):[0-9a-z]+>/g, ':$1:')
    .replace(/<#(\d+)>/g, (_, id) => '#' + (findChannel(id)?.name || id))
    .replace(/<@&(\d+)>/g, (_, id) => '@' + ((serverId && get().servers[serverId]?.roles.find((r: any) => r.id === id)?.name) || 'role'))
    .replace(/<t:(-?\d+)(?::\w)?>/g, (_, s) => new Date(Number(s) * 1000).toLocaleString())
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')
    .replace(/```|\*\*|__|~~|\|\||`/g, '')
    .replace(/\s+/g, ' ');
}
