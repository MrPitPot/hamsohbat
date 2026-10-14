import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CornerUpLeft, Download, FileText, Pencil, Pin, Plus, Reply, Smile, SmilePlus, Trash2, X, Copy, ArrowDown, SendHorizontal, Forward, MessageSquareText, Link, Hash, Vote, Sticker as StickerIcon,
  EyeOff, Upload, BellDot, AtSign, Volume2, Clock,
} from 'lucide-react';
import { useStore, get, set, act, toast, loadMessages, jumpTo, wsSend, openModal, displayName, roleColor, findChannel, can, canIn, ackSoon, dmName, markUnread, timedOut, navigate, updateSettings, P, CH, REL } from './store';
import { api, upload } from './api';
import { t, lang } from './i18n';
import { Avatar, Popover, openMenu, fmtTime, fmtStamp, fmtDate, fmtSize, Name, num } from './ui';
import { Markdown, isJumbo, plain } from './markdown';
import { EMOJI, QUICK } from './emoji';
import { MAX_FILE_SIZE, MAX_MESSAGE_LENGTH } from '../shared/perms';
import { Embeds, VoicePlayer, VoiceRecorder, MicButton, voiceMessageMs } from './Extras';
import { CustomEmojiTab, ReactionEmoji, PollView, StickerView, StickerPicker, ForwardedView, RichEmbeds, WebhookAvatar, ThreadChip, allCustomEmojis, emojiToken } from './features/Messages';

export function EmojiPicker({ onPick }: { onPick: (e: string) => void }) {
  const hasCustom = allCustomEmojis().length > 0;
  const [cat, setCat] = useState(hasCustom ? -1 : 0);
  return (
    <div className="emoji-picker">
      <div className="emoji-tabs">
        {hasCustom && (
          <button className={cat === -1 ? 'active' : ''} onClick={() => setCat(-1)} title={t('Server Emoji')}>
            ⭐
          </button>
        )}
        {EMOJI.map((c, i) => (
          <button key={c.name} className={i === cat ? 'active' : ''} onClick={() => setCat(i)} title={t(c.name)}>
            {c.icon}
          </button>
        ))}
      </div>
      {cat === -1 ? (
        <CustomEmojiTab onPick={onPick} />
      ) : (
        <div className="emoji-grid">
          {EMOJI[cat].list.map((e) => (
            <button key={e} onClick={() => onPick(e)}>
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function toggleReaction(m: any, emoji: string) {
  const mine = m.reactions.find((r: any) => r.emoji === emoji)?.users.includes(get().me.id);
  act(api(mine ? 'DELETE' : 'PUT', `/api/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`));
}

function SpoilerWrap({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={'spoiler-att' + (open ? ' open' : '')} onClickCapture={(e) => !open && (e.preventDefault(), e.stopPropagation(), setOpen(true))}>
      {children}
      {!open && (
        <span className="spoiler-label">
          <EyeOff size={16} /> {t('SPOILER')}
        </span>
      )}
    </div>
  );
}

export function Attachment({ a }: { a: any }) {
  const url = a.url + '/' + encodeURIComponent(a.name);
  const spoiler = /^SPOILER_/.test(a.name);
  let el: React.ReactNode;
  if (/^image\/(png|jpeg|gif|webp|avif)$/.test(a.type)) {
    const scale = a.width && a.height ? Math.min(1, 400 / a.width, 300 / a.height) : 0;
    el = (
      <img
        className="att-image"
        src={url}
        alt={a.name}
        loading="lazy"
        style={scale ? { width: Math.round(a.width * scale), aspectRatio: `${a.width} / ${a.height}` } : undefined}
        onClick={() => openModal('image', { url, name: a.name })}
      />
    );
  } else if (/^video\/(mp4|webm|quicktime)$/.test(a.type)) el = <video className="att-video" src={url} controls preload="metadata" />;
  else if (/^audio\//.test(a.type) && voiceMessageMs(a.name)) el = <VoicePlayer url={url} ms={voiceMessageMs(a.name)!} />;
  else if (/^audio\//.test(a.type))
    el = (
      <div className="att-audio">
        <span dir="auto">{a.name}</span>
        <audio src={url} controls preload="none" />
      </div>
    );
  else
    el = (
      <a className="att-file" href={url} download={a.name}>
        <FileText size={32} />
        <div>
          <div className="att-name" dir="auto">
            {a.name}
          </div>
          <div className="att-size">{fmtSize(a.size)}</div>
        </div>
        <Download size={20} />
      </a>
    );
  return spoiler ? <SpoilerWrap>{el}</SpoilerWrap> : <>{el}</>;
}

function ReplyPreview({ reply, serverId, channelId }: any) {
  useStore((s: any) => s.users[reply.authorId]);
  if (reply.deleted)
    return (
      <div className="reply-preview">
        <CornerUpLeft size={14} /> <i>{t('Original message was deleted')}</i>
      </div>
    );
  return (
    <div className="reply-preview" onClick={() => jumpTo(channelId, reply.id)}>
      <CornerUpLeft size={14} />
      <Avatar userId={reply.authorId} size={16} />
      <b style={{ color: roleColor(reply.authorId, serverId) }}>{displayName(reply.authorId, serverId)}</b>
      <span dir="auto">{reply.content ? plain(reply.content, serverId) : <i>{t('Click to see attachment')}</i>}</span>
    </div>
  );
}

function EditBox({ m, onDone }: { m: any; onDone: () => void }) {
  const [text, setText] = useState(m.content);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const save = async () => {
    const v = text.trim();
    if (v === m.content) return onDone();
    if (!v && !m.attachments.length && !m.poll && !m.sticker) return openModal('confirm', { title: t('Delete Message'), text: t('Are you sure you want to delete this message?'), danger: true, action: t('Delete'), onConfirm: () => api('DELETE', '/api/messages/' + m.id) });
    if (await act(api('PATCH', '/api/messages/' + m.id, { content: v }))) onDone();
  };
  return (
    <div className="edit-box">
      <textarea
        ref={ref}
        dir="auto"
        value={text}
        maxLength={MAX_MESSAGE_LENGTH}
        rows={Math.min(10, text.split('\n').length)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            save();
          }
        }}
      />
      <small>
        {t('escape to')} <a onClick={onDone}>{t('cancel')}</a> • {t('enter to')} <a onClick={save}>{t('save')}</a>
      </small>
    </div>
  );
}

const canThreadIn = (ch: any) => ch && [CH.TEXT, CH.ANNOUNCEMENT].includes(ch.type) && canIn(ch, P.CREATE_THREADS);
const messageLink = (m: any) => {
  const ch = findChannel(m.channelId);
  return `${location.origin}/channels/${ch?.serverId || '@me'}/${m.channelId}/${m.id}`;
};
function speak(text: string) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[؀-ۿ]/.test(text) ? 'fa-IR' : 'en-US';
    speechSynthesis.speak(u);
  } catch {}
}

const MessageItem = memo(function MessageItem({ m, prevId, compact, serverId, editing, setEditing, highlight }: any) {
  const meId = useStore((s: any) => s.me.id);
  useStore((s: any) => s.users[m.authorId]);
  useStore((s: any) => (serverId ? s.servers[serverId]?.members[m.authorId] : null));
  useStore((s: any) => (serverId ? s.servers[serverId]?.roles : null));
  useStore((s: any) => (serverId ? s.servers[serverId]?.members[s.me.id] : null));
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const ch = findChannel(m.channelId);
  const mine = m.authorId === meId;
  const canManage = serverId ? canIn(ch, P.MANAGE_MESSAGES) : false;
  const canPin = serverId ? canManage : true;
  const canReact = !serverId || canIn(ch, P.ADD_REACTIONS);
  const mentioned = !m.type && (m.mentionEveryone || m.mentions.includes(meId));
  const hook = m.webhook;
  const openAuthor = () => !hook && openModal('profile', { userId: m.authorId, serverId });

  if (m.type === 1 || m.type === 2 || m.type === 3)
    return (
      <div className="msg system" data-id={m.id}>
        <span className="sys-icon">{m.type === 1 ? (lang() === 'fa' ? '←' : '→') : m.type === 3 ? <MessageSquareText size={14} /> : <Pin size={14} />}</span>
        <span>
          <b className="clickable" onClick={openAuthor}>
            {displayName(m.authorId, serverId)}
          </b>{' '}
          {m.type === 1 ? (
            t('joined the server.')
          ) : m.type === 3 ? (
            <>
              {t('started a thread:')}{' '}
              <a onClick={() => m.thread && openThread(serverId, m.thread.id)}>
                <b>{m.thread?.name || m.content}</b>
              </a>
              . <a onClick={() => openModal('threads', { channelId: m.channelId })}>{t('See all threads.')}</a>
            </>
          ) : (
            <>
              {t('pinned')}{' '}
              <a onClick={() => m.replyTo && jumpTo(m.channelId, m.replyTo)}>{t('a message')}</a> {t('to this channel.')}
            </>
          )}
        </span>
        <time>{fmtStamp(m.createdAt)}</time>
      </div>
    );

  const del = (e?: React.MouseEvent) => {
    if (e?.shiftKey) return act(api('DELETE', '/api/messages/' + m.id));
    openModal('confirm', { title: t('Delete Message'), text: t('Are you sure you want to delete this message?'), danger: true, action: t('Delete'), onConfirm: () => api('DELETE', '/api/messages/' + m.id) });
  };
  const pin = () => act(api(m.pinned ? 'DELETE' : 'PUT', `/api/messages/${m.id}/pin`));
  const reply = () => {
    set((s: any) => ({ replyTo: { ...s.replyTo, [m.channelId]: m } }));
    document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
  };
  const thread = () => openModal('createThread', { channelId: m.channelId, messageId: m.id, initialName: plain(m.content || '', serverId).slice(0, 40) || t('New Thread') });
  const forward = () => openModal('forward', { messageId: m.id });
  const menu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, img, video')) return;
    openMenu(e, [
      { label: t('Add Reaction'), icon: <SmilePlus size={16} />, hidden: !canReact, onClick: () => setPicker(document.querySelector<HTMLElement>(`[data-id="${m.id}"]`)) },
      { label: t('Edit Message'), icon: <Pencil size={16} />, hidden: !mine || !!hook || !!m.forwarded, onClick: () => setEditing(m.id) },
      { label: t('Reply'), icon: <Reply size={16} />, onClick: reply },
      { label: t('Forward'), icon: <Forward size={16} />, onClick: forward },
      { label: t('Create Thread'), icon: <MessageSquareText size={16} />, hidden: !canThreadIn(ch) || !!m.thread, onClick: thread },
      { label: m.pinned ? t('Unpin Message') : t('Pin Message'), icon: <Pin size={16} />, hidden: !canPin, onClick: pin },
      { sep: true },
      { label: t('Mark Unread'), icon: <BellDot size={16} />, onClick: () => markUnread(m.channelId, prevId || '0') },
      { label: t('Copy Text'), icon: <Copy size={16} />, hidden: !m.content, onClick: () => navigator.clipboard?.writeText(plain(m.content, serverId)) },
      { label: t('Copy Message Link'), icon: <Link size={16} />, onClick: () => navigator.clipboard?.writeText(messageLink(m)) },
      { label: t('Speak Message'), icon: <Volume2 size={16} />, hidden: !m.content || typeof speechSynthesis === 'undefined', onClick: () => speak(displayName(m.authorId, serverId) + ': ' + plain(m.content, serverId)) },
      { sep: true },
      { label: t('Delete Message'), icon: <Trash2 size={16} />, danger: true, hidden: !mine && !canManage, onClick: () => del() },
      { sep: true },
      { label: t('Copy Message ID'), icon: <Hash size={16} />, onClick: () => navigator.clipboard?.writeText(m.id) },
    ]);
  };

  const authorName = hook ? hook.name : displayName(m.authorId, serverId);
  return (
    <div className={'msg' + (compact ? ' compact' : '') + (Date.now() - m.createdAt < 4000 ? ' fresh' : '') + (mentioned ? ' mentioned' : '') + (highlight ? ' highlight' : '') + (picker ? ' hover' : '')} data-id={m.id} onContextMenu={menu}>
      {m.reply && <ReplyPreview reply={m.reply} serverId={serverId} channelId={m.channelId} />}
      <div className="msg-row">
        <div className="msg-gutter">
          {compact ? (
            <time>{fmtTime(m.createdAt)}</time>
          ) : (
            <span className="clickable" onClick={openAuthor}>
              {hook ? <WebhookAvatar hook={hook} /> : <Avatar userId={m.authorId} size={40} />}
            </span>
          )}
        </div>
        <div className="msg-body">
          {!compact && (
            <div className="msg-head">
              <b className="clickable" style={{ color: hook ? undefined : roleColor(m.authorId, serverId) }} onClick={openAuthor}>
                {authorName}
              </b>
              {hook && <span className="bot-tag">{hook.imported ? t('IMPORTED') : t('APP')}</span>}
              <time title={fmtDate(m.createdAt)}>{fmtStamp(m.createdAt)}</time>
            </div>
          )}
          {editing ? (
            <EditBox m={m} onDone={() => setEditing(null)} />
          ) : (
            m.content && (
              <div className={'msg-content' + (isJumbo(m.content) ? ' jumbo' : '')} dir={isJumbo(m.content) ? undefined : 'auto'}>
                <Markdown text={m.content} serverId={serverId} />
                {m.editedAt && (
                  <small className="edited" title={fmtStamp(m.editedAt)}>
                    {' '}
                    {t('(edited)')}
                  </small>
                )}
              </div>
            )
          )}
          {m.forwarded && <ForwardedView f={m.forwarded} />}
          {m.poll && <PollView m={m} />}
          {m.sticker && <StickerView sticker={m.sticker} />}
          {m.attachments.length > 0 && (
            <div className="attachments">
              {m.attachments.map((a: any) => (
                <Attachment key={a.id} a={a} />
              ))}
            </div>
          )}
          {m.embeds?.length > 0 && <RichEmbeds embeds={m.embeds} />}
          {!editing && m.content && !m.embeds?.length && <Embeds content={m.content} />}
          {m.reactions.length > 0 && (
            <div className="reactions">
              {m.reactions.map((r: any) => (
                <button
                  key={r.emoji}
                  className={'reaction' + (r.users.includes(meId) ? ' mine' : '')}
                  title={r.users.map((u: string) => displayName(u, serverId)).join('، ')}
                  onClick={() => canReact && toggleReaction(m, r.emoji)}
                >
                  <ReactionEmoji emoji={r.emoji} /> {num(r.users.length)}
                </button>
              ))}
              {canReact && (
                <button className="reaction add" title={t('Add Reaction')} onClick={(e) => setPicker(e.currentTarget)}>
                  <SmilePlus size={16} />
                </button>
              )}
            </div>
          )}
          {m.thread && <ThreadChip m={m} serverId={serverId} />}
        </div>
      </div>
      {!editing && (
        <div className="msg-tools">
          {canReact &&
            QUICK.slice(0, 3).map((e) => (
              <button key={e} onClick={() => toggleReaction(m, e)} className="quick">
                {e}
              </button>
            ))}
          {canReact && (
            <button title={t('Add Reaction')} onClick={(e) => setPicker(picker ? null : e.currentTarget)}>
              <SmilePlus size={18} />
            </button>
          )}
          {mine && !hook && !m.forwarded ? (
            <button title={t('Edit Message')} onClick={() => setEditing(m.id)}>
              <Pencil size={18} />
            </button>
          ) : (
            <button title={t('Reply')} onClick={reply}>
              <Reply size={18} />
            </button>
          )}
          {mine && !hook && !m.forwarded && (
            <button title={t('Reply')} onClick={reply}>
              <Reply size={18} />
            </button>
          )}
          <button title={t('Forward')} onClick={forward}>
            <Forward size={18} />
          </button>
          {canThreadIn(ch) && !m.thread && (
            <button title={t('Create Thread')} onClick={thread}>
              <MessageSquareText size={18} />
            </button>
          )}
          {canPin && (
            <button title={m.pinned ? t('Unpin Message') : t('Pin Message')} className={m.pinned ? 'on' : ''} onClick={pin}>
              <Pin size={18} />
            </button>
          )}
          {(mine || canManage) && (
            <button title={t('Delete Message')} className="danger" onClick={del}>
              <Trash2 size={18} />
            </button>
          )}
        </div>
      )}
      {picker && (
        <Popover anchor={picker} onClose={() => setPicker(null)}>
          <EmojiPicker
            onPick={(e) => {
              setPicker(null);
              if (!m.reactions.find((r: any) => r.emoji === e)?.users.includes(meId)) toggleReaction(m, e);
            }}
          />
        </Popover>
      )}
    </div>
  );
});

function openThread(serverId: string | null, id: string) {
  navigate(serverId, id);
}

function sameDay(a: number, b: number) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

function MessageList({ channelId, serverId, editing, setEditing }: any) {
  const box = useStore((s: any) => s.messages[channelId]);
  const jump = useStore((s: any) => s.jump);
  const ref = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prev = useRef({ first: null as string | null, last: null as string | null, height: 0 });
  const [highlight, setHighlight] = useState<string | null>(null);
  const [away, setAway] = useState(false);
  const list: any[] = box?.list || [];
  const ch = findChannel(channelId);
  const meId = useStore((s: any) => s.me.id);
  // Where the user stopped reading when they opened the channel ("New messages" line).
  const liveMarker = useStore((s: any) => s.readStates[channelId]?.lastReadId);
  const [readMarker, setReadMarker] = useState<string | null>(() => {
    const rs = get().readStates[channelId];
    return rs && ch?.lastMessageId && ch.lastMessageId > rs.lastReadId ? rs.lastReadId : null;
  });
  // "Mark Unread" moves the line.
  useEffect(() => {
    if (liveMarker && ch?.lastMessageId && liveMarker < ch.lastMessageId && (!readMarker || liveMarker < readMarker)) setReadMarker(liveMarker);
  }, [liveMarker]);

  useLayoutEffect(() => {
    const el = ref.current!;
    const first = list[0]?.id || null;
    const last = list[list.length - 1]?.id || null;
    const p = prev.current;
    // Older messages were prepended: keep the viewport on what the user was reading.
    if (p.first && first !== p.first && last === p.last && list.some((m) => m.id === p.first)) el.scrollTop += el.scrollHeight - p.height;
    else if (stick.current) el.scrollTop = el.scrollHeight;
    prev.current = { first, last, height: el.scrollHeight };
  }, [list]);

  // Images and embeds change height after they load; stay glued to the bottom while they do.
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const el = ref.current;
      if (el && stick.current) el.scrollTop = el.scrollHeight;
      if (el) prev.current.height = el.scrollHeight;
    });
    ro.observe(inner.current!);
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!jump || jump.channelId !== channelId) return;
    const el = ref.current?.querySelector<HTMLElement>(`[data-id="${jump.messageId}"]`);
    if (!el) return;
    stick.current = false;
    el.scrollIntoView({ block: 'center' });
    setHighlight(jump.messageId);
    const timer = setTimeout(() => setHighlight(null), 2000);
    return () => clearTimeout(timer);
  }, [jump]);

  const onScroll = () => {
    const el = ref.current!;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const b = get().messages[channelId];
    stick.current = fromBottom < 60 && !b?.hasNewer;
    setAway(fromBottom > 400 || !!b?.hasNewer);
    if (!b || b.loading) return;
    if (el.scrollTop < 300 && b.hasMore && b.list.length) loadMessages(channelId, 'older');
    else if (fromBottom < 300 && b.hasNewer) loadMessages(channelId, 'newer');
    if (stick.current) ackSoon(channelId);
  };
  const toPresent = async () => {
    if (get().messages[channelId]?.hasNewer) await loadMessages(channelId, 'initial');
    stick.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAway(false);
  };

  const items: React.ReactNode[] = [];
  let dividerShown = false;
  list.forEach((m, i) => {
    const p = list[i - 1];
    if (readMarker && !dividerShown && m.id > readMarker && m.authorId !== meId && (!p || p.id <= readMarker)) {
      dividerShown = true;
      items.push(
        <div className="new-sep" key={'n' + m.id}>
          <span>{t('New messages')}</span>
        </div>
      );
    }
    if (!p || !sameDay(p.createdAt, m.createdAt))
      items.push(
        <div className="day-sep" key={'d' + m.id}>
          <span>{fmtDate(m.createdAt)}</span>
        </div>
      );
    const compact =
      !!p && !p.type && !m.type && p.authorId === m.authorId && (p.webhook?.name || '') === (m.webhook?.name || '') && !m.reply && !m.forwarded && m.createdAt - p.createdAt < 7 * 60000 && sameDay(p.createdAt, m.createdAt);
    items.push(<MessageItem key={m.id} m={m} prevId={p?.id} compact={compact} serverId={serverId} editing={editing === m.id} setEditing={setEditing} highlight={highlight === m.id} />);
  });

  const parent = ch?.type === CH.THREAD ? findChannel(ch.parentId) : null;
  return (
    <div className="messages-wrap">
      <div className="messages" ref={ref} onScroll={onScroll}>
        <div ref={inner}>
          {box && !box.hasMore && (
            <div className="channel-start">
              {ch?.type === CH.THREAD ? (
                <>
                  <div className="start-icon">
                    <MessageSquareText size={36} />
                  </div>
                  <h2 dir="auto">{ch.name}</h2>
                  <p>
                    {t('Started by {name}', { name: ch.ownerId ? displayName(ch.ownerId, serverId) : '' })}
                    {parent ? ' • #' + parent.name : ''}
                  </p>
                </>
              ) : ch?.serverId ? (
                <>
                  <div className="start-icon">#</div>
                  <h2>{t('Welcome to #{name}!', { name: ch.name })}</h2>
                  <p>{t('This is the start of the #{name} channel.', { name: ch.name })}</p>
                </>
              ) : ch ? (
                <>
                  {ch.type === CH.DM && <Avatar userId={ch.recipients.find((r: string) => r !== get().me.id)} size={80} />}
                  <h2>{dmName(ch)}</h2>
                  <p>{ch.type === CH.DM ? t('This is the beginning of your direct message history with {name}.', { name: dmName(ch) }) : t('Welcome to the beginning of the group.')}</p>
                </>
              ) : null}
            </div>
          )}
          {box?.loading && <div className="loading-row">{t('Loading…')}</div>}
          {items}
          <div className="messages-end" />
        </div>
      </div>
      {away && (
        <button className="jump-present" onClick={toPresent}>
          {box?.hasNewer ? t("You're viewing older messages") : t('Jump to present')} <ArrowDown size={16} />
        </button>
      )}
    </div>
  );
}

function TypingBar({ channelId, serverId }: any) {
  const typing = useStore((s: any) => s.typing[channelId]);
  const meId = useStore((s: any) => s.me.id);
  const ch = findChannel(channelId);
  const [, tick] = useState(0);
  const lastSent = slowmodeSent[channelId] || 0;
  const wait = ch?.rateLimit && !canIn(ch, P.MANAGE_MESSAGES) && !canIn(ch, P.MANAGE_CHANNELS) ? Math.ceil((lastSent + ch.rateLimit * 1000 - Date.now()) / 1000) : 0;
  useEffect(() => {
    if (!ch?.rateLimit) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [ch?.rateLimit]);
  const ids = Object.keys(typing || {}).filter((i) => i !== meId);
  let text = '';
  if (ids.length === 1) text = t('{a} is typing…', { a: displayName(ids[0], serverId) });
  else if (ids.length === 2) text = t('{a} and {b} are typing…', { a: displayName(ids[0], serverId), b: displayName(ids[1], serverId) });
  else if (ids.length > 2) text = t('Several people are typing…');
  return (
    <div className="typing-bar">
      {text && (
        <>
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
          {text}
        </>
      )}
      {ch?.rateLimit > 0 && (
        <span className="slowmode" title={t('Slowmode is enabled')}>
          <Clock size={12} /> {wait > 0 ? num(wait) + 's' : t('Slowmode is enabled')}
        </span>
      )}
    </div>
  );
}

const drafts = new Map<string, string>();
const slowmodeSent: Record<string, number> = {};

type Ac = { kind: '@' | '#' | ':'; q: string; start: number; index: number };

function Composer({ channelId, serverId, onEditLast }: any) {
  const ch = findChannel(channelId);
  const replyTo = useStore((s: any) => s.replyTo[channelId]);
  const meId = useStore((s: any) => s.me.id);
  const replyPing = useStore((s: any) => s.settings.replyPing !== false);
  useStore((s: any) => (serverId ? s.servers[serverId]?.roles : null));
  useStore((s: any) => (serverId ? s.servers[serverId]?.members[meId] : null));
  useStore((s: any) => (serverId ? s.servers[serverId]?.channels : null));
  const blocked = useStore((s: any) => ch?.type === CH.DM && s.relationships[ch.recipients.find((r: string) => r !== meId)] === REL.BLOCKED);
  const [text, setText] = useState(drafts.get(channelId) || '');
  const [files, setFiles] = useState<{ file: File; url: string | null; progress: number; spoiler: boolean }[]>([]);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const [stickers, setStickers] = useState<HTMLElement | null>(null);
  const [ac, setAc] = useState<Ac | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const server = serverId ? get().servers[serverId] : null;
  const isThread = ch?.type === CH.THREAD;
  const canSend = !serverId || canIn(ch, isThread ? P.SEND_IN_THREADS : P.SEND_MESSAGES);
  const canAttach = !serverId || canIn(ch, P.ATTACH_FILES);
  const mod = !!serverId && (canIn(ch, P.MANAGE_MESSAGES) || canIn(ch, P.MANAGE_CHANNELS));
  const isTimedOut = server && timedOut(server, meId);

  useEffect(() => {
    drafts.set(channelId, text);
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 300) + 'px';
  }, [text]);
  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) ta.current?.focus();
  }, [channelId, replyTo]);
  useEffect(() => () => files.forEach((f) => f.url && URL.revokeObjectURL(f.url)), []);
  // Ctrl+Shift+U opens the file picker.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyU' && canAttach) {
        e.preventDefault();
        fileInput.current?.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canAttach]);

  const candidates = useMemo(() => {
    const s = get();
    const ids: string[] = serverId ? Object.keys(s.servers[serverId]?.members || {}) : ch?.recipients || [];
    return ids.map((id) => s.users[id]).filter(Boolean);
  }, [ac?.kind, serverId, channelId]);
  const matches = useMemo(() => {
    if (!ac) return [];
    const q = ac.q.toLowerCase();
    if (ac.kind === '#') {
      if (!server) return [];
      return server.channels
        .filter((c: any) => c.type !== CH.CATEGORY && c.type !== CH.THREAD && c.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((c: any) => ({ id: c.id, insert: '#' + c.name, label: c.name, channel: c }));
    }
    if (ac.kind === ':') {
      if (q.length < 2) return [];
      return allCustomEmojis()
        .filter((e) => e.name.toLowerCase().includes(q))
        .sort((a, b) => Number(b.serverId === serverId) - Number(a.serverId === serverId))
        .slice(0, 8)
        .map((e) => ({ id: e.id, insert: ':' + e.name + ':', label: ':' + e.name + ':', emoji: e }));
    }
    const list: any[] = candidates
      .filter((u: any) => u.username.includes(q) || u.displayName.toLowerCase().includes(q) || displayName(u.id, serverId).toLowerCase().includes(q))
      .slice(0, 8)
      .map((u: any) => ({ id: u.id, insert: '@' + u.username, user: u }));
    if (server && canIn(ch, P.MENTION_EVERYONE)) {
      for (const r of server.roles) if (r.id !== server.id && r.name.toLowerCase().includes(q)) list.push({ id: r.id, insert: '@' + r.name.replace(/\s+/g, '_'), role: r });
      if ('everyone'.startsWith(q)) list.push({ id: 'everyone', insert: '@everyone' });
      if ('here'.startsWith(q)) list.push({ id: 'here', insert: '@here' });
    }
    return list.slice(0, 10);
  }, [ac, candidates]);

  const addFiles = (list: FileList | File[]) => {
    if (!canAttach) return toast('You do not have permission to do that');
    const next = [...files];
    for (const file of Array.from(list)) {
      if (file.size > MAX_FILE_SIZE) {
        toast(t('{name} is larger than 25 MB', { name: file.name }));
        continue;
      }
      if (next.length >= 10) break;
      next.push({ file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null, progress: 0, spoiler: false });
    }
    setFiles(next);
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setText(v);
    const upto = v.slice(0, e.target.selectionStart);
    const m = upto.match(/(?:^|\s)([@#:])([\p{L}\p{N}_.\-]*)$/u);
    setAc(m ? { kind: m[1] as any, q: m[2], start: upto.length - m[2].length - 1, index: 0 } : null);
    if (v && Date.now() - lastTyping.current > 5000) {
      lastTyping.current = Date.now();
      wsSend({ op: 'typing', channelId });
    }
  };
  const complete = (item: any) => {
    if (!ac) return;
    const el = ta.current!;
    const before = text.slice(0, ac.start) + item.insert + ' ';
    setText(before + text.slice(el.selectionStart));
    setAc(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };
  const insert = (s: string) => {
    const el = ta.current!;
    const start = el.selectionStart ?? text.length;
    // Custom emoji are shown as :name: while typing and turned into tokens when sent.
    const m = s.match(/^<a?:(\w+):[0-9a-z]+>$/);
    const piece = m ? `:${m[1]}: ` : s;
    const next = text.slice(0, start) + piece + text.slice(el.selectionEnd ?? start);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + piece.length, start + piece.length);
    });
  };

  const clearReply = () => set((s: any) => ({ replyTo: { ...s.replyTo, [channelId]: null } }));
  const post = async (body: any) => {
    const r = await api('POST', `/api/channels/${channelId}/messages`, { replyTo: replyTo?.id, replyMention: replyPing, ...body });
    slowmodeSent[channelId] = Date.now();
    clearReply();
    return r;
  };
  const sendVoice = async (r: { blob: Blob; ms: number; ext: string } | null) => {
    setRecording(false);
    if (!r) return;
    setSending(true);
    try {
      const f = await upload(r.blob, `voice-message-${r.ms}.${r.ext}`);
      await post({ content: '', attachments: [f.id] });
    } catch (e: any) {
      toast(e.message);
    }
    setSending(false);
  };
  const sendSticker = async (id: string) => {
    setStickers(null);
    await act(post({ content: '', sticker: id }));
  };

  /** Turns @name, #channel and :emoji: into real mentions and emoji tokens. */
  const encode = (raw: string) => {
    const byName = new Map(candidates.map((u: any) => [u.username, u.id]));
    let content = raw.replace(/(^|\s)@([\p{L}\p{N}_.]+)/gu, (all, pre, name) => {
      let n = name.toLowerCase();
      let tail = '';
      // Allow trailing dots ("hi @ali.") without losing the mention.
      while (n && !byName.has(n) && n.endsWith('.')) {
        n = n.slice(0, -1);
        tail += '.';
      }
      if (byName.has(n)) return `${pre}<@${byName.get(n)}>${tail}`;
      const role = server?.roles.find((r: any) => r.id !== server.id && r.name.replace(/\s+/g, '_').toLowerCase() === name.toLowerCase());
      return role && canIn(ch, P.MENTION_EVERYONE) ? `${pre}<@&${role.id}>` : all;
    });
    if (server)
      content = content.replace(/(^|\s)#([\p{L}\p{N}_\-]+)/gu, (all, pre, name) => {
        const c = server.channels.find((x: any) => x.name === name && x.type !== CH.CATEGORY);
        return c ? `${pre}<#${c.id}>` : all;
      });
    const emojis = allCustomEmojis().sort((a, b) => Number(b.serverId === serverId) - Number(a.serverId === serverId));
    content = content.replace(/(^|[^<a\w]):(\w{2,32}):/g, (all, pre, name) => {
      const e = emojis.find((x) => x.name === name);
      return e ? pre + emojiToken(e) : all;
    });
    return content;
  };

  const slowWait = () => (ch?.rateLimit && !mod ? Math.ceil(((slowmodeSent[channelId] || 0) + ch.rateLimit * 1000 - Date.now()) / 1000) : 0);
  const send = async () => {
    if (sending) return;
    const raw = text.trim();
    if (!raw && !files.length) return;
    if (raw.length > MAX_MESSAGE_LENGTH) return toast('Message is too long');
    const wait = slowWait();
    if (wait > 0) return toast(t('Slowmode is on. Wait {n} seconds.', { n: num(wait) }));
    const content = encode(raw);
    setSending(true);
    try {
      const ids: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        let dims: any = {};
        if (f.url) {
          try {
            const bmp = await createImageBitmap(f.file);
            dims = { w: bmp.width, h: bmp.height };
          } catch {}
        }
        const name = (f.spoiler && !f.file.name.startsWith('SPOILER_') ? 'SPOILER_' : '') + f.file.name;
        const r = await upload(f.file, name, {
          ...dims,
          onProgress: (p) => setFiles((cur) => cur.map((x, j) => (j === i ? { ...x, progress: p } : x))),
        });
        ids.push(r.id);
      }
      await post({ content, attachments: ids });
      setText('');
      drafts.delete(channelId);
      files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
      setFiles([]);
      lastTyping.current = 0;
    } catch (e: any) {
      if (e.data?.wait) slowmodeSent[channelId] = Date.now() - (ch.rateLimit - e.data.wait) * 1000;
      toast(e.message);
    }
    setSending(false);
    requestAnimationFrame(() => ta.current?.focus());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (ac && matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        return setAc({ ...ac, index: (ac.index + d + matches.length) % matches.length });
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        return complete(matches[ac.index] || matches[0]);
      }
      if (e.key === 'Escape') return setAc(null);
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowUp' && !text) {
      e.preventDefault();
      onEditLast();
    } else if (e.key === 'Escape' && replyTo) clearReply();
  };

  if (isTimedOut)
    return (
      <div className="composer disabled">
        <Clock size={16} /> {t('You are timed out until {time}.', { time: fmtStamp(server.members[meId].timeoutUntil) })}
      </div>
    );
  if (ch?.type === CH.ANNOUNCEMENT && !canIn(ch, P.MANAGE_MESSAGES)) return <div className="composer disabled">{t('Only moderators can post in announcement channels.')}</div>;
  if (!canSend) return <div className="composer disabled">{t('You do not have permission to send messages in this channel.')}</div>;
  if (blocked) return <div className="composer disabled">{t('You blocked this user. Unblock them to send a message.')}</div>;

  const plusMenu = (e: React.MouseEvent) =>
    openMenu(
      e,
      [
        { label: t('Upload a File'), icon: <Upload size={16} />, hidden: !canAttach, onClick: () => fileInput.current?.click() },
        { label: t('Create Poll'), icon: <Vote size={16} />, onClick: () => openModal('poll', { channelId }) },
        { label: t('Create Thread'), icon: <MessageSquareText size={16} />, hidden: !canThreadIn(ch), onClick: () => openModal('createThread', { channelId }) },
      ],
      true
    );
  const name = ch?.serverId ? (isThread ? '' : '#') + ch.name : ch ? (ch.type === CH.DM ? '@' : '') + dmName(ch) : '';
  return (
    <div
      className="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      {ac && matches.length > 0 && (
        <div className="autocomplete">
          <div className="ac-title">{ac.kind === '#' ? t('Text Channels') : ac.kind === ':' ? t('Emoji Matching :{q}', { q: ac.q }) : t('Members')}</div>
          {matches.map((it: any, i: number) => (
            <button key={it.id} className={i === ac.index ? 'active' : ''} onMouseEnter={() => setAc({ ...ac, index: i })} onMouseDown={(e) => (e.preventDefault(), complete(it))}>
              {it.user ? (
                <Avatar userId={it.id} size={24} />
              ) : it.channel ? (
                <Hash size={18} />
              ) : it.emoji ? (
                <img className="custom-emoji" src={`/api/files/${it.emoji.id}`} alt="" />
              ) : it.role ? (
                <AtSign size={18} style={{ color: it.role.color || undefined }} />
              ) : (
                <span className="ac-at">@</span>
              )}
              <span>{it.user ? displayName(it.id, serverId) : it.channel ? it.label : it.emoji ? it.label : it.role ? '@' + it.role.name : it.insert}</span>
              {it.user && <small dir="ltr">{it.user.username}</small>}
              {it.emoji && <small>{it.emoji.serverName}</small>}
            </button>
          ))}
        </div>
      )}
      {replyTo && (
        <div className="reply-bar">
          <span>
            {t('Replying to')} <b>{replyTo.webhook ? replyTo.webhook.name : displayName(replyTo.authorId, serverId)}</b>
          </span>
          {replyTo.authorId !== meId && (
            <button className={'reply-ping' + (replyPing ? ' on' : '')} title={t('Mention the author')} onClick={() => updateSettings({ replyPing: !replyPing })}>
              <AtSign size={14} /> {replyPing ? t('ON') : t('OFF')}
            </button>
          )}
          <button className="icon-btn" onClick={clearReply}>
            <X size={16} />
          </button>
        </div>
      )}
      {files.length > 0 && (
        <div className="pending-files">
          {files.map((f, i) => (
            <div key={i} className={'pending-file' + (f.spoiler ? ' spoiler-on' : '')}>
              {f.url ? <img src={f.url} alt="" /> : <FileText size={48} />}
              <div className="pf-name" dir="auto">
                {f.file.name}
              </div>
              {sending ? (
                <div className="pf-progress">
                  <div style={{ width: f.progress * 100 + '%' }} />
                </div>
              ) : (
                <div className="pf-actions">
                  <button className="pf-remove" onClick={() => setFiles(files.map((x, j) => (j === i ? { ...x, spoiler: !x.spoiler } : x)))} title={t('Mark as Spoiler')}>
                    <EyeOff size={16} />
                  </button>
                  <button className="pf-remove" onClick={() => setFiles(files.filter((_, j) => j !== i))} title={t('Remove')}>
                    <Trash2 size={16} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {recording ? (
        <VoiceRecorder onDone={sendVoice} />
      ) : (
        <div className="composer-row">
          <button className="icon-btn" title={t('More')} onClick={plusMenu}>
            <Plus size={22} />
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => (e.target.files && addFiles(e.target.files), (e.target.value = ''))} />
          <textarea
            ref={ta}
            dir="auto"
            rows={1}
            value={text}
            placeholder={t('Message {name}', { name })}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onBlur={() => setTimeout(() => setAc(null), 150)}
            onPaste={(e) => {
              const fs = Array.from(e.clipboardData.files);
              if (fs.length) {
                e.preventDefault();
                addFiles(fs);
              }
            }}
          />
          <button className="icon-btn" title={t('Stickers')} onClick={(e) => setStickers(stickers ? null : e.currentTarget)}>
            <StickerIcon size={22} />
          </button>
          <button className="icon-btn" title={t('Emoji')} onClick={(e) => setPicker(picker ? null : e.currentTarget)}>
            <Smile size={22} />
          </button>
          {!text.trim() && !files.length && canAttach && typeof MediaRecorder !== 'undefined' ? (
            <MicButton onClick={() => setRecording(true)} />
          ) : (
            <button className="icon-btn send-btn" title={t('Send')} disabled={sending || (!text.trim() && !files.length)} onClick={send}>
              <SendHorizontal size={22} />
            </button>
          )}
        </div>
      )}
      {text.length > MAX_MESSAGE_LENGTH - 200 && <div className={'char-count' + (text.length > MAX_MESSAGE_LENGTH ? ' over' : '')}>{MAX_MESSAGE_LENGTH - text.length}</div>}
      {picker && (
        <Popover anchor={picker} onClose={() => setPicker(null)}>
          <EmojiPicker onPick={insert} />
        </Popover>
      )}
      {stickers && (
        <Popover anchor={stickers} onClose={() => setStickers(null)}>
          <StickerPicker onPick={sendSticker} />
        </Popover>
      )}
    </div>
  );
}

export function ChatPane({ channelId, serverId }: { channelId: string; serverId: string | null }) {
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    if (!get().messages[channelId]) loadMessages(channelId);
  }, [channelId]);
  const editLast = () => {
    const s = get();
    const last = [...(s.messages[channelId]?.list || [])].reverse().find((m: any) => m.authorId === s.me.id && !m.type && !m.forwarded);
    if (last) setEditing(last.id);
  };
  return (
    <div className="chat-pane">
      <MessageList channelId={channelId} serverId={serverId} editing={editing} setEditing={setEditing} />
      <Composer channelId={channelId} serverId={serverId} onEditLast={editLast} />
      <TypingBar channelId={channelId} serverId={serverId} />
    </div>
  );
}

/** A compact, read-only message used in the pins and search lists. */
export function MessageCard({ m, serverId, onClick, action }: any) {
  return (
    <div className="msg-card" onClick={onClick}>
      {m.webhook ? <WebhookAvatar hook={m.webhook} size={32} /> : <Avatar userId={m.authorId} size={32} />}
      <div className="msg-body">
        <div className="msg-head">
          <b style={{ color: roleColor(m.authorId, serverId) }}>{m.webhook ? m.webhook.name : <Name userId={m.authorId} serverId={serverId} />}</b>
          <time>{fmtStamp(m.createdAt)}</time>
        </div>
        {m.content && (
          <div className="msg-content" dir="auto">
            <Markdown text={m.content} serverId={serverId} />
          </div>
        )}
        {m.poll && <div className="muted">📊 {m.poll.question}</div>}
        {m.sticker && <StickerView sticker={m.sticker} />}
        {m.forwarded && <ForwardedView f={m.forwarded} />}
        {m.attachments.length > 0 && (
          <div className="attachments">
            {m.attachments.map((a: any) => (
              <Attachment key={a.id} a={a} />
            ))}
          </div>
        )}
      </div>
      {action}
    </div>
  );
}
export { can };
