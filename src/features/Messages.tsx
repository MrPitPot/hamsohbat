// Message extras: custom emoji, polls, stickers, forwarded messages, rich embeds, webhook authors and thread chips.
import React, { useMemo, useState } from 'react';
import { Check, CornerDownRight, Forward, MessageSquareText, Search, Sticker as StickerIcon, Trash2, Vote, X, Plus } from 'lucide-react';
import { useStore, get, act, toast, openModal, closeModal, navigate, findChannel, displayName, dmName, sortedDms, orderedChannels, canIn, jumpTo, P, CH } from '../store';
import { api } from '../api';
import { t } from '../i18n';
import { Modal, Field, Avatar, Toggle, fmtStamp, num, Popover } from '../ui';
import { Markdown } from '../markdown';
import { Attachment } from '../Chat';

// ---------------------------------------------------------------- custom emoji
/** Every custom emoji from the servers you are in, for the picker and `:name:` autocomplete. */
export function allCustomEmojis(): { id: string; name: string; animated: boolean; serverId: string; serverName: string }[] {
  const s = get();
  const out: any[] = [];
  for (const id of s.serverOrder) {
    const sv = s.servers[id];
    for (const e of sv?.emojis || []) out.push({ ...e, serverId: id, serverName: sv.name });
  }
  return out;
}
/** Local emoji are stored as files; ids we do not know (imported messages) come from Discord's CDN. */
export function emojiUrl(id: string, animated = false) {
  const s = get();
  for (const sid of s.serverOrder) if (s.servers[sid]?.emojis?.some((e: any) => e.id === id)) return `/api/files/${id}`;
  if (!/^\d{15,}$/.test(id)) return `/api/files/${id}`;
  return `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'webp'}?size=96`;
}
export function CustomEmoji({ token, big }: { token: string; big?: boolean }) {
  const m = token.match(/^<(a?):([\w]+):([0-9a-z]+)>$/);
  if (!m) return <>{token}</>;
  return <img className={'custom-emoji' + (big ? ' big' : '')} src={emojiUrl(m[3], !!m[1])} alt={`:${m[2]}:`} title={`:${m[2]}:`} draggable={false} loading="lazy" />;
}
/** Reaction label: unicode emoji as text, custom emoji as an image. */
export function ReactionEmoji({ emoji }: { emoji: string }) {
  return emoji.startsWith('<') ? <CustomEmoji token={emoji} /> : <span>{emoji}</span>;
}
export const emojiToken = (e: { id: string; name: string; animated?: boolean }) => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;

export function CustomEmojiTab({ onPick }: { onPick: (token: string) => void }) {
  const list = allCustomEmojis();
  const [q, setQ] = useState('');
  const shown = list.filter((e) => !q || e.name.toLowerCase().includes(q.toLowerCase()));
  if (!list.length) return <p className="muted center small-note">{t('No custom emoji yet. Server admins can add them in Server Settings → Emoji.')}</p>;
  const groups: Record<string, any[]> = {};
  for (const e of shown) (groups[e.serverName] ||= []).push(e);
  return (
    <div className="custom-emoji-tab">
      <input className="plain-input small" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Find the perfect emoji')} autoFocus />
      {Object.entries(groups).map(([name, items]) => (
        <React.Fragment key={name}>
          <div className="emoji-group-title">{name}</div>
          <div className="emoji-grid">
            {items.map((e) => (
              <button key={e.id} title={`:${e.name}:`} onClick={() => onPick(emojiToken(e))}>
                <img src={`/api/files/${e.id}`} alt={e.name} loading="lazy" />
              </button>
            ))}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- polls
export function PollView({ m }: { m: any }) {
  const meId = useStore((s: any) => s.me.id);
  const poll = m.poll;
  const [busy, setBusy] = useState(false);
  const ended = poll.expiresAt <= Date.now();
  const votes: Record<string, string[]> = poll.votes || {};
  const total = new Set(Object.values(votes).flat()).size;
  const mine = (id: number) => (votes[id] || []).includes(meId);
  const voted = poll.answers.some((a: any) => mine(a.id));
  const showResults = ended || voted;
  const maxVotes = Math.max(0, ...poll.answers.map((a: any) => (votes[a.id] || []).length));
  const vote = async (id: number) => {
    if (ended || busy) return;
    setBusy(true);
    await act(api(mine(id) ? 'DELETE' : 'PUT', `/api/messages/${m.id}/poll/${id}`));
    setBusy(false);
  };
  const left = poll.expiresAt - Date.now();
  const timeLeft = left > 86400000 ? t('{n}d left', { n: num(Math.ceil(left / 86400000)) }) : left > 3600000 ? t('{n}h left', { n: num(Math.ceil(left / 3600000)) }) : t('{n}m left', { n: num(Math.max(1, Math.ceil(left / 60000))) });
  const canEnd = !ended && (m.authorId === meId || canIn(findChannel(m.channelId), P.MANAGE_MESSAGES));
  return (
    <div className="poll">
      <div className="poll-q" dir="auto">
        {poll.question}
      </div>
      <small className="muted">{poll.multi ? t('Select one or more answers') : t('Select one answer')}</small>
      <div className="poll-answers">
        {poll.answers.map((a: any) => {
          const n = (votes[a.id] || []).length;
          const pct = total ? Math.round((n / total) * 100) : 0;
          return (
            <button key={a.id} className={'poll-answer' + (mine(a.id) ? ' mine' : '') + (showResults ? ' results' : '') + (ended && n === maxVotes && n > 0 ? ' winner' : '')} disabled={ended} onClick={() => vote(a.id)}>
              {showResults && <span className="poll-bar" style={{ width: pct + '%' }} />}
              {a.emoji && <span className="poll-emoji">{a.emoji.startsWith('<') ? <CustomEmoji token={a.emoji} /> : a.emoji}</span>}
              <span className="poll-text" dir="auto">
                {a.text}
              </span>
              {showResults ? (
                <span className="poll-pct">
                  {num(n)} • {num(pct)}%
                </span>
              ) : (
                <span className={'poll-check' + (poll.multi ? ' square' : '')}>{mine(a.id) && <Check size={12} />}</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="poll-foot">
        <span>
          {t('{n} votes', { n: num(total) })} • {ended ? t('Poll closed') : timeLeft}
        </span>
        {canEnd && (
          <button className="btn link small" onClick={() => act(api('POST', `/api/messages/${m.id}/poll/end`))}>
            {t('End Poll Now')}
          </button>
        )}
      </div>
    </div>
  );
}

export function PollModal({ channelId }: { channelId: string }) {
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState<{ text: string; emoji: string }[]>([
    { text: '', emoji: '' },
    { text: '', emoji: '' },
  ]);
  const [hours, setHours] = useState(24);
  const [multi, setMulti] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = question.trim() && answers.filter((a) => a.text.trim()).length >= 2;
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api('POST', `/api/channels/${channelId}/messages`, { content: '', poll: { question, answers: answers.filter((a) => a.text.trim()).map((a) => ({ text: a.text, emoji: a.emoji || null })), hours, multi } });
      closeModal();
    } catch (e: any) {
      setError(t(e.message));
    }
    setBusy(false);
  };
  return (
    <Modal title={t('Create a Poll')} width={480}>
      <div className="modal-body">
        <Field label={t('Question')}>
          <input dir="auto" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} placeholder={t('What question do you want to ask?')} autoFocus />
        </Field>
        <span className="field-label">{t('Answers')}</span>
        {answers.map((a, i) => (
          <div className="poll-edit-row" key={i}>
            <input className="emoji-in" value={a.emoji} maxLength={8} placeholder="🙂" onChange={(e) => setAnswers(answers.map((x, j) => (j === i ? { ...x, emoji: e.target.value } : x)))} />
            <input dir="auto" value={a.text} maxLength={55} placeholder={t('Type your answer')} onChange={(e) => setAnswers(answers.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
            {answers.length > 2 && (
              <button className="icon-btn" onClick={() => setAnswers(answers.filter((_, j) => j !== i))} title={t('Remove')}>
                <Trash2 size={16} />
              </button>
            )}
          </div>
        ))}
        {answers.length < 10 && (
          <button className="btn small" onClick={() => setAnswers([...answers, { text: '', emoji: '' }])}>
            <Plus size={14} /> {t('Add another answer')}
          </button>
        )}
        <div className="two-col" style={{ marginTop: 16 }}>
          <Field label={t('Duration')}>
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {[1, 4, 8, 24, 72, 168, 336].map((h) => (
                <option key={h} value={h}>
                  {h < 24 ? t('{n} hours', { n: num(h) }) : t('{n} days', { n: num(h / 24) })}
                </option>
              ))}
            </select>
          </Field>
          <div className="setting-row compact-row">
            <div>
              <b>{t('Allow Multiple Answers')}</b>
            </div>
            <Toggle checked={multi} onChange={setMulti} />
          </div>
        </div>
        {error && <div className="form-error">{error}</div>}
      </div>
      <div className="modal-foot">
        <button className="btn link" onClick={closeModal}>
          {t('Cancel')}
        </button>
        <button className="btn primary" disabled={!ready || busy} onClick={submit}>
          <Vote size={16} /> {t('Post')}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- stickers
export function StickerView({ sticker }: { sticker: any }) {
  // Stickers are local files; ones from imported Discord messages fall back to Discord's CDN.
  const [src, setSrc] = useState(sticker.url || `/api/files/${sticker.id}`);
  return (
    <img
      className="sticker"
      src={src}
      alt={sticker.name}
      title={sticker.name}
      loading="lazy"
      draggable={false}
      onError={() => !src.includes('discord') && setSrc(`https://media.discordapp.net/stickers/${sticker.id}.webp?size=160`)}
    />
  );
}
export function StickerPicker({ onPick }: { onPick: (id: string) => void }) {
  const servers = useStore((s: any) => s.serverOrder.map((id: string) => s.servers[id]).filter((sv: any) => sv?.stickers?.length));
  if (!servers.length)
    return (
      <div className="sticker-picker empty-picker">
        <StickerIcon size={40} />
        <p className="muted">{t('No stickers yet. Server admins can upload them in Server Settings → Stickers.')}</p>
      </div>
    );
  return (
    <div className="sticker-picker">
      {servers.map((sv: any) => (
        <React.Fragment key={sv.id}>
          <div className="emoji-group-title">{sv.name}</div>
          <div className="sticker-grid">
            {sv.stickers.map((st: any) => (
              <button key={st.id} title={st.name} onClick={() => onPick(st.id)}>
                <img src={`/api/files/${st.id}`} alt={st.name} loading="lazy" />
              </button>
            ))}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- forwarded messages & embeds
export function ForwardedView({ f }: { f: any }) {
  const ch = findChannel(f.channelId);
  const where = ch ? (ch.serverId ? '#' + ch.name : dmName(ch)) : null;
  return (
    <div className="forwarded">
      <div className="fw-label">
        <Forward size={14} /> <i>{t('Forwarded')}</i>
      </div>
      {f.content && (
        <div className="msg-content" dir="auto">
          <Markdown text={f.content} serverId={f.serverId} />
        </div>
      )}
      {f.attachments?.length > 0 && (
        <div className="attachments">
          {f.attachments.map((a: any) => (
            <Attachment key={a.id} a={a} />
          ))}
        </div>
      )}
      {f.embeds?.length > 0 && <RichEmbeds embeds={f.embeds} />}
      <div className="fw-source">
        {where && (
          <a onClick={() => jumpTo(f.channelId, f.messageId)}>
            {where} • {fmtStamp(f.createdAt)}
          </a>
        )}
        {!where && <span>{fmtStamp(f.createdAt)}</span>}
      </div>
    </div>
  );
}

const hexColor = (c: any) => (typeof c === 'number' ? '#' + c.toString(16).padStart(6, '0') : typeof c === 'string' ? c : undefined);
export function RichEmbeds({ embeds }: { embeds: any[] }) {
  return (
    <div className="rich-embeds">
      {embeds.map((e, i) => (
        <div key={i} className="rich-embed" style={{ borderInlineStartColor: hexColor(e.color) || 'var(--bg-mod)' }}>
          <div className="re-main">
            {e.author?.name && (
              <div className="re-author">
                {e.author.icon_url && <img src={e.author.icon_url} alt="" />}
                {e.author.url ? (
                  <a href={e.author.url} target="_blank" rel="noopener noreferrer">
                    {e.author.name}
                  </a>
                ) : (
                  <span>{e.author.name}</span>
                )}
              </div>
            )}
            {e.title && (
              <div className="re-title" dir="auto">
                {e.url ? (
                  <a href={e.url} target="_blank" rel="noopener noreferrer">
                    {e.title}
                  </a>
                ) : (
                  e.title
                )}
              </div>
            )}
            {e.description && (
              <div className="re-desc" dir="auto">
                <Markdown text={e.description} />
              </div>
            )}
            {e.fields?.length > 0 && (
              <div className="re-fields">
                {e.fields.map((f: any, j: number) => (
                  <div key={j} className={'re-field' + (f.inline ? ' inline' : '')}>
                    <b dir="auto">{f.name}</b>
                    <div dir="auto">
                      <Markdown text={f.value || ''} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {e.image?.url && <img className="re-image" src={e.image.url} alt="" loading="lazy" onClick={() => openModal('image', { url: e.image.url, name: '' })} />}
            {(e.footer?.text || e.timestamp) && (
              <div className="re-footer">
                {e.footer?.icon_url && <img src={e.footer.icon_url} alt="" />}
                <span>
                  {e.footer?.text}
                  {e.footer?.text && e.timestamp ? ' • ' : ''}
                  {e.timestamp ? fmtStamp(new Date(e.timestamp).getTime()) : ''}
                </span>
              </div>
            )}
          </div>
          {e.thumbnail?.url && <img className="re-thumb" src={e.thumbnail.url} alt="" loading="lazy" />}
        </div>
      ))}
    </div>
  );
}

/** Messages sent through a webhook (or imported from Discord) show the sender's name and avatar instead of a user. */
export function WebhookAvatar({ hook, size = 40 }: { hook: any; size?: number }) {
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {hook.avatar ? <img src={hook.avatar} alt="" draggable={false} /> : <div className="avatar-fallback" style={{ background: '#5865f2' }}>{[...(hook.name || '?')][0]?.toUpperCase()}</div>}
    </div>
  );
}

export function ThreadChip({ m, serverId }: { m: any; serverId: string | null }) {
  const th = m.thread;
  if (!th) return null;
  return (
    <div className="thread-chip" onClick={() => navigate(serverId, th.id)}>
      <CornerDownRight size={16} className="tc-arrow" />
      <MessageSquareText size={16} />
      <b dir="auto">{th.name}</b>
      <span className="muted">{th.messageCount ? t('{n} Messages', { n: num(th.messageCount) }) : t('See Thread')}</span>
      {th.archived && <span className="tag">{t('Archived')}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- forward modal
export function ForwardModal({ messageId }: { messageId: string }) {
  const servers = useStore((s: any) => s.servers);
  const order = useStore((s: any) => s.serverOrder);
  useStore((s: any) => s.dms);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const targets = useMemo(() => {
    const out: { id: string; label: string; sub: string; dm?: any }[] = [];
    for (const d of sortedDms()) out.push({ id: d.id, label: dmName(d), sub: d.type === CH.DM ? t('Direct Message') : t('Group DM'), dm: d });
    for (const sid of order) {
      const sv = servers[sid];
      for (const c of orderedChannels(sv)) if ([CH.TEXT, CH.ANNOUNCEMENT].includes(c.type) && canIn(c, P.SEND_MESSAGES)) out.push({ id: c.id, label: '#' + c.name, sub: sv.name });
    }
    return out;
  }, [servers, order]);
  const shown = targets.filter((x) => !q || x.label.toLowerCase().includes(q.toLowerCase()) || x.sub.toLowerCase().includes(q.toLowerCase())).slice(0, 60);
  const send = async () => {
    setBusy(true);
    let ok = 0;
    for (const id of sel) if (await act(api('POST', `/api/messages/${messageId}/forward`, { channelId: id, comment }))) ok++;
    setBusy(false);
    if (ok) {
      toast(t('Forwarded to {n} places', { n: num(ok) }), 'ok');
      closeModal();
    }
  };
  return (
    <Modal title={t('Forward To')} width={460}>
      <div className="modal-body">
        <div className="search-box">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search')} autoFocus />
          <Search size={16} />
        </div>
        <div className="pick-list tall">
          {shown.map((x) => (
            <button key={x.id} className="pick-row" onClick={() => setSel(sel.includes(x.id) ? sel.filter((i) => i !== x.id) : sel.length < 5 ? [...sel, x.id] : sel)}>
              {x.dm?.type === CH.DM ? <Avatar userId={x.dm.recipients.find((r: string) => r !== get().me.id)} size={28} /> : <span className="pick-hash">{x.dm ? '👥' : '#'}</span>}
              <b dir="auto">{x.label.replace(/^#/, '')}</b>
              <small>{x.sub}</small>
              <span className={'checkbox' + (sel.includes(x.id) ? ' on' : '')}>{sel.includes(x.id) && <Check size={14} />}</span>
            </button>
          ))}
        </div>
        <input className="plain-input" dir="auto" value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('Add an optional message…')} maxLength={2000} />
      </div>
      <div className="modal-foot">
        <button className="btn link" onClick={closeModal}>
          {t('Cancel')}
        </button>
        <button className="btn primary" disabled={!sel.length || busy} onClick={send}>
          <Forward size={16} /> {t('Send')}
        </button>
      </div>
    </Modal>
  );
}

/** A floating picker with custom emoji, used for reactions alongside the normal emoji tabs. */
export function ExpressionPopover({ anchor, onClose, onEmoji, onSticker }: { anchor: HTMLElement; onClose: () => void; onEmoji?: (e: string) => void; onSticker?: (id: string) => void }) {
  return (
    <Popover anchor={anchor} onClose={onClose}>
      {onSticker ? <StickerPicker onPick={onSticker} /> : <CustomEmojiTab onPick={(x) => onEmoji?.(x)} />}
    </Popover>
  );
}
export { X };
