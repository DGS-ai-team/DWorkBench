import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X, LoaderCircle, Terminal, Ellipsis, Check } from "lucide-react";
import { api, type LogFile } from "./api";
export function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={"brand " + (small ? "small" : "")}>
      <span className="brand-icon">
        <Terminal size={small ? 18 : 21} />
      </span>
      <span>
        LogDesk<span className="brand-dot">.</span>
      </span>
    </div>
  );
}
export function Spinner() {
  return <LoaderCircle className="spin" size={16} />;
}
export function Modal({
  title,
  children,
  close,
  drawer = false,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  drawer?: boolean;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={drawer ? "modal drawer" : `modal ${wide ? "wide" : ""}`}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <header className="modal-head">
        <div>
          <h2 id={id}>{title}</h2>
        </div>
        <button className="icon-button" aria-label="关闭" onClick={close}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export type MenuAction = {
  label: string;
  icon?: ReactNode;
  action: () => void;
  checked?: boolean;
  danger?: boolean;
};

export function ActionMenu({
  label,
  items,
}: {
  label: string;
  items: MenuAction[];
}) {
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [opened, setOpened] = useState(false);
  const id = useId();
  function close() {
    menu.current?.hidePopover();
  }
  function show(last = false) {
    const element = menu.current,
      button = trigger.current;
    if (!element || !button) return;
    const anchor = button.getBoundingClientRect();
    element.showPopover();
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, anchor.bottom + bounds.height + 6 > window.innerHeight - 8 ? anchor.top - bounds.height - 6 : anchor.bottom + 6)}px`;
    const buttons = element.querySelectorAll<HTMLButtonElement>("button");
    buttons[last ? buttons.length - 1 : 0]?.focus();
  }
  useEffect(() => {
    if (!opened) return;
    const dismissOnScroll = (event: Event) => {
      // Only an ancestor scroller can move the trigger. Live log bodies scroll
      // independently and must not dismiss menus elsewhere in the workspace.
      const target = event.target;
      if (target === window ||
          (target instanceof Node && trigger.current && target.contains(trigger.current))) close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", dismissOnScroll, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", dismissOnScroll, true);
    };
  }, [opened]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-button"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-controls={id}
        aria-expanded={opened}
        onClick={() => (opened ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show(event.key === "ArrowUp");
          }
        }}
      >
        <Ellipsis size={17} />
      </button>
      <div
        id={id}
        ref={menu}
        className="action-menu"
        role="menu"
        aria-label={label}
        popover="auto"
        onToggle={(event) =>
          setOpened(event.currentTarget.matches(":popover-open"))
        }
        onKeyDown={(event) => {
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button",
            ),
          ];
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
            trigger.current?.focus();
          } else if (event.key === "Tab") {
            close();
            trigger.current?.focus();
          } else if (
            ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
          ) {
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      buttons.length) %
                    buttons.length;
            buttons[next]?.focus();
          }
        }}
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={item.checked}
            className={item.danger ? "danger" : ""}
            onClick={() => {
              close();
              trigger.current?.focus();
              item.action();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.checked && <Check size={14} />}
          </button>
        ))}
      </div>
    </>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export async function download(groupId: string, file: LogFile) {
  await api(`/groups/${groupId}/files/${file.id}/download-check`);
  const link = document.createElement("a");
  link.href = `/api/groups/${groupId}/files/${file.id}/download`;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
}
