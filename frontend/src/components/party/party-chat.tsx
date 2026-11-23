import { MessagesSquare, RotateCw, SendHorizontal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";

import { ProfileAvatar } from "@/components/account/profile-avatar";
import { Button } from "@/components/ui/button";
import {
  activityText,
  Party,
  partyTimeline,
  usePartyActivity,
  usePartyChat,
  type ActivityEntry,
  type Message,
} from "@/lib/party";
import { useCompactShell } from "@/lib/shell-mode";
import { cn } from "@/lib/utils";

// The longest message the backend keeps.
const maxLength = 500;

// "2:04 PM", in this device's own conventions.
const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

// The party's chat: oldest at the top, the newest kept in view as they come
// unless the user scrolled up to read. While it shows, nothing counts as
// unread. A message shows at once while it sends; one that couldn't be sent
// says so, and a click sends it again. The party's activity log (who paused,
// skipped, came or went) sits between the messages as quiet one-line rows, in
// time order.
export function PartyChat({ className }: { className?: string }) {
  const chat = usePartyChat();
  const messages = chat.messages ?? [];
  const activity = usePartyActivity();
  const items = partyTimeline(messages, activity.entries);
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const compact = useCompactShell();

  useEffect(() => {
    Party.SetChatOpen(true).catch(() => {});
    return () => void Party.SetChatOpen(false).catch(() => {});
  }, []);
  // In the player's sheet (ADR-0063, a #134 bottom sheet) the sheet closes by a
  // drag down from its grabber: a downward touch on the messages is the
  // list's to scroll, so it never reaches the sheet (which would move the
  // sheet instead of reading back).
  useEffect(() => {
    const el = list.current;
    if (!el || !compact) return undefined;
    const keep = (event: TouchEvent) => event.stopPropagation();
    el.addEventListener("touchstart", keep, { passive: true });
    return () => el.removeEventListener("touchstart", keep);
  }, [compact]);
  // Each new message or line of the log, kept in view.
  const count = items.length;
  useLayoutEffect(() => {
    const el = list.current;
    if (el && pinned.current && count > 0) el.scrollTop = el.scrollHeight;
  }, [count]);

  const send = (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    pinned.current = true;
    Party.SendMessage(body).catch(() => setDraft(body));
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div
        ref={list}
        role="log"
        aria-label="Chat"
        aria-live="polite"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1 py-2 outline-none"
      >
        {items.length === 0 ? (
          <div className="m-auto flex max-w-60 flex-col items-center gap-2 py-10 text-center">
            <MessagesSquare aria-hidden className="size-6 text-muted-foreground" />
            <p className="text-body font-[590]">No messages yet</p>
            <p className="text-small text-muted-foreground">
              Only people in this party can see the chat.
            </p>
          </div>
        ) : (
          items.map((item, index) => {
            const before = items[index - 1];
            if (item.type === "activity") {
              return <ActivityRow key={"activity:" + item.entry.id} entry={item.entry} />;
            }
            return (
              <ChatMessage
                key={item.message.key}
                message={item.message}
                // A run of messages from the same member reads as one.
                grouped={
                  before?.type === "message" && before.message.memberId === item.message.memberId
                }
              />
            );
          })
        )}
      </div>
      <form onSubmit={send} className="flex items-center gap-2 border-t border-foreground/8 pt-3">
        <input
          aria-label="Message"
          placeholder="Message"
          value={draft}
          maxLength={maxLength}
          onChange={(event) => setDraft(event.target.value)}
          // The player's keys stay out of the way while typing.
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
          // 44 pt and 16 px for a finger: under 16 px WebKit zooms the page
          // when the field takes the keyboard.
          className="h-10 min-w-0 flex-1 rounded-full bg-foreground/6 px-4 text-body outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:text-[1rem]"
        />
        <Button
          type="submit"
          size="icon-lg"
          className="rounded-full pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          aria-label="Send"
          disabled={!draft.trim()}
        >
          <SendHorizontal />
        </Button>
      </form>
    </div>
  );
}

// One line of the party's log, quiet between the messages and with no face
// of its own: what happened, then when.
function ActivityRow({ entry }: { entry: ActivityEntry }) {
  return (
    <p className="px-3 text-center text-[0.6875rem] text-muted-foreground">
      {activityText(entry)}
      {" · "}
      <time dateTime={new Date(entry.at).toISOString()}>{clock.format(entry.at)}</time>
    </p>
  );
}

function ChatMessage({ message, grouped }: { message: Message; grouped: boolean }) {
  const failed = message.status === "failed";
  return (
    <div
      className={cn("flex items-end gap-2", message.mine && "flex-row-reverse", grouped && "-mt-2")}
    >
      {!message.mine && (
        <span className={cn("shrink-0", grouped && "invisible")}>
          <ProfileAvatar
            profile={{
              name: message.name,
              avatar: message.avatarUrl,
              avatarColor: message.avatarColor,
            }}
            className="size-7 text-[0.625rem]"
          />
        </span>
      )}
      <div className={cn("flex max-w-[80%] flex-col gap-0.5", message.mine && "items-end")}>
        {!message.mine && !grouped && (
          <p className="px-3 text-[0.6875rem] font-[590] text-muted-foreground">{message.name}</p>
        )}
        <p
          className={cn(
            "rounded-2xl px-3 py-2 text-body break-words whitespace-pre-wrap",
            message.mine ? "bg-sun text-sun-foreground" : "bg-foreground/8",
            message.status === "sending" && "opacity-60",
          )}
        >
          {message.body}
        </p>
        {failed && (
          <button
            type="button"
            onClick={() => void Party.RetryMessage(message.key).catch(() => {})}
            className="flex items-center gap-1 px-2 text-[0.6875rem] font-[590] text-destructive-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCw aria-hidden className="size-3" />
            Not sent. Try again
          </button>
        )}
      </div>
    </div>
  );
}
