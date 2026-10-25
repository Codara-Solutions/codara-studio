import React, { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import CustomSelect, { type CustomSelectOption } from "./CustomSelect";

/**
 * The building blocks every Settings page is drawn with. A page is a stack of
 * sections under the dialog's title bar, which carries the page title and its
 * one-line description so they stay put while the page scrolls.
 *
 *   <SettingsSection title="Window" description="One line, if any.">
 *     <ToggleRow title="..." desc="..." checked={on} onChange={setOn} />
 *     <SelectRow title="..." desc="..." value={v} options={...} onChange={setV} />
 *     <SettingRow title="..." desc="..." control={<button className="spark-btn">Go</button>} />
 *     <Advanced name="Window advanced">
 *       <SettingRow ... />
 *     </Advanced>
 *   </SettingsSection>
 *
 * A section is a heading over one card; the card stacks its rows with
 * hairlines between them. A row is a title and a one-line description on the
 * left with its control on the right, or, `stacked`, with a wide control
 * (text field, list) under the text. Rare options go in an `Advanced`
 * disclosure at the foot of the card. A section that lays out its own
 * content (a toolbar over a list) is `plain`, and puts its rows in a
 * `SettingsCard` or its list in `.st-list`, which is drawn as a card too.
 * The look lives in styles.css under `.st-*`, scoped to the dialog surface,
 * so these components carry structure and no colours.
 *
 * `anchor` names a section or row for Settings search: a result scrolls to
 * the element carrying the same `data-setting-anchor`, and flashes it. A row
 * whose title is a string is its own anchor. Every literal title must have
 * an entry in settings-index.ts (scripts/test-settings-search.cjs checks).
 */

export function SettingsPage({ children }: { children: React.ReactNode }) {
  return <div className="st-page">{children}</div>;
}

// The disclosure a picked search result sits behind, while the dialog is
// scrolling to it. A page that folds rows away opens the fold on a match.
export const SettingsRevealContext = createContext<string | null>(null);

/** Opens a fold when Settings search is taking the user to a row inside it. */
export function useRevealOnSearch(disclosure: string, open: () => void): void {
  const reveal = useContext(SettingsRevealContext);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (reveal === disclosure) openRef.current();
  }, [reveal, disclosure]);
}

function ChevronGlyph() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/**
 * A quiet inline "show more" toggle with a chevron that turns when open, for
 * an explainer next to a toolbar. Rows that most people never need go in
 * `Advanced` instead.
 */
export function Disclosure({
  open,
  onToggle,
  anchor,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  anchor?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="st-disclosure"
      aria-expanded={open}
      data-setting-anchor={anchor}
      onClick={onToggle}
    >
      <ChevronGlyph />
      {children}
    </button>
  );
}

/**
 * The fold at the foot of a card for options most people never touch. Closed
 * by default; `name` is its search key, so an index entry with
 * `reveal: name` opens it before scrolling to the row inside. Names are
 * unique within a page. `label` is what the toggle says ("Advanced" unless
 * the fold has a better name), `hint` a short note shown while it is shut.
 */
export function Advanced({
  name,
  label = "Advanced",
  hint,
  defaultOpen = false,
  children,
}: {
  name: string;
  label?: string;
  hint?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useRevealOnSearch(name, () => setOpen(true));
  const bodyId = useId();
  return (
    <div className={`st-advanced${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="st-advanced__toggle"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        data-setting-anchor={name}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="st-advanced__chevron">
          <ChevronGlyph />
        </span>
        <span className="st-advanced__label">{label}</span>
        {hint && !open ? <span className="st-advanced__hint">{hint}</span> : null}
      </button>
      {open ? (
        <div id={bodyId} className="st-advanced__body">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A key name drawn as a small keycap inside running text. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="st-kbd st-kbd--inline">{children}</kbd>;
}

export function SettingsSection({
  title,
  description,
  actions,
  anchor,
  plain,
  live,
  children,
}: {
  title?: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  anchor?: string;
  /** Children are laid out as they are, outside a card (toolbars, lists). */
  plain?: boolean;
  /** The rows are live values that screen readers should announce. */
  live?: boolean;
  children?: React.ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      className="st-section"
      data-setting-anchor={anchor ?? title}
      aria-labelledby={title ? titleId : undefined}
    >
      {title || actions ? (
        <div className="st-section__head">
          <div className="st-section__titles">
            {title ? (
              <h3 id={titleId} className="st-section__title">
                {title}
              </h3>
            ) : null}
            {description ? <p className="st-section__desc">{description}</p> : null}
          </div>
          {actions ? <div className="st-section__actions">{actions}</div> : null}
        </div>
      ) : null}
      {children ? (
        plain ? (
          <div className="st-section__body" aria-live={live ? "polite" : undefined}>
            {children}
          </div>
        ) : (
          <SettingsCard live={live}>{children}</SettingsCard>
        )
      ) : null}
    </section>
  );
}

/** A rounded card of rows split by hairlines. A section draws one itself. */
export function SettingsCard({
  live,
  tone,
  children,
}: {
  live?: boolean;
  /** "danger" outlines the card for a group of destructive actions. */
  tone?: "danger";
  children: React.ReactNode;
}) {
  return (
    <div
      className={`st-card${tone === "danger" ? " st-card--danger" : ""}`}
      aria-live={live ? "polite" : undefined}
    >
      {children}
    </div>
  );
}

export function SettingRow({
  title,
  desc,
  control,
  disabled,
  htmlFor,
  descId,
  anchor,
  stacked,
  tone,
  children,
}: {
  title: React.ReactNode;
  desc?: React.ReactNode;
  control?: React.ReactNode;
  disabled?: boolean;
  /** The control the title labels; a click on the title then reaches it. */
  htmlFor?: string;
  /** Id for the description, so a control can name it in aria-describedby. */
  descId?: string;
  anchor?: string;
  /** The control takes the full width under the label (text fields, lists). */
  stacked?: boolean;
  tone?: "danger";
  /** Extra content under the row (a sub-setting that belongs to this one). */
  children?: React.ReactNode;
}) {
  const TitleTag = htmlFor ? "label" : "span";
  return (
    <div
      className={`st-row${stacked ? " st-row--stacked" : ""}${disabled ? " is-disabled" : ""}${tone === "danger" ? " st-row--danger" : ""}`}
      data-setting-anchor={anchor ?? (typeof title === "string" ? title : undefined)}
    >
      <div className="st-row__main">
        <div className="st-row__text">
          <TitleTag htmlFor={htmlFor} className="st-row__title">
            {title}
          </TitleTag>
          {desc ? (
            <div id={descId} className="st-row__desc">
              {desc}
            </div>
          ) : null}
        </div>
        {control !== undefined && control !== null ? (
          <div className="st-row__control">{control}</div>
        ) : null}
      </div>
      {children ? <div className="st-row__extra">{children}</div> : null}
    </div>
  );
}

export function ToggleRow({
  title,
  desc,
  checked,
  disabled,
  anchor,
  onChange,
  children,
}: {
  title: string;
  desc?: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  anchor?: string;
  onChange: (next: boolean) => void;
  children?: React.ReactNode;
}) {
  const id = useId();
  return (
    <SettingRow
      title={title}
      desc={desc}
      anchor={anchor}
      disabled={disabled}
      htmlFor={`${id}-switch`}
      descId={desc ? `${id}-desc` : undefined}
      control={
        <Switch
          id={`${id}-switch`}
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          ariaLabel={title}
          describedBy={desc ? `${id}-desc` : undefined}
        />
      }
    >
      {children}
    </SettingRow>
  );
}

/** A row whose control is a dropdown. The title names the dropdown. */
export function SelectRow({
  title,
  desc,
  value,
  options,
  onChange,
  width = 220,
  disabled,
  anchor,
  setting,
  children,
}: {
  title: string;
  desc?: React.ReactNode;
  value: string;
  options: ReadonlyArray<CustomSelectOption>;
  onChange: (next: string) => void;
  /** Trigger width in px. */
  width?: number;
  disabled?: boolean;
  anchor?: string;
  /** A data-setting hook on the control, for specs. */
  setting?: string;
  children?: React.ReactNode;
}) {
  const id = useId();
  return (
    <SettingRow
      title={title}
      desc={desc}
      anchor={anchor}
      disabled={disabled}
      descId={desc ? `${id}-desc` : undefined}
      control={
        <div className="st-row__select" data-setting={setting}>
          <CustomSelect
            ariaLabel={title}
            describedBy={desc ? `${id}-desc` : undefined}
            width={width}
            value={value}
            options={options}
            disabled={disabled}
            onChange={onChange}
          />
        </div>
      }
    >
      {children}
    </SettingRow>
  );
}

/**
 * A button that asks twice: the first click arms it and it turns red with
 * its confirm label, the second runs the action. It disarms when the pointer
 * or focus leaves it, or after a few seconds, so a stray click never
 * destroys anything.
 */
export function ConfirmButton({
  children,
  confirmLabel,
  onConfirm,
  disabled,
  title,
}: {
  children: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  title?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={`spark-btn st-confirm-btn${armed ? " is-danger is-armed" : ""}`}
      disabled={disabled}
      title={title}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      onMouseLeave={() => setArmed(false)}
      onBlur={() => setArmed(false)}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}

/**
 * A destructive action: its title, what it removes, and a button that asks
 * twice. Put these last on a page, in a `SettingsSection` titled for what
 * they remove.
 */
export function DangerRow({
  title,
  desc,
  action,
  confirmLabel = "Click again to confirm",
  onConfirm,
  disabled,
  anchor,
  buttonTitle,
}: {
  title: string;
  desc?: React.ReactNode;
  /** The button's resting label. */
  action: string;
  confirmLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  anchor?: string;
  buttonTitle?: string;
}) {
  return (
    <SettingRow
      title={title}
      desc={desc}
      anchor={anchor}
      tone="danger"
      control={
        <ConfirmButton
          confirmLabel={confirmLabel}
          onConfirm={onConfirm}
          disabled={disabled}
          title={buttonTitle}
        >
          {action}
        </ConfirmButton>
      }
    />
  );
}

/**
 * The pure-visual part of the switch, so the same geometry can be a real
 * role=switch button or a decorative indicator inside a larger clickable
 * control, where a nested button would be invalid HTML.
 */
export function SwitchTrack({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden className={`st-switch${checked ? " is-on" : ""}`}>
      <span className="st-switch__knob" />
    </span>
  );
}

export function Switch({
  id,
  checked,
  disabled,
  onChange,
  ariaLabel,
  describedBy,
}: {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
  describedBy?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      disabled={disabled}
      className="st-switch-btn"
      onClick={() => onChange(!checked)}
    >
      <SwitchTrack checked={checked} />
    </button>
  );
}

export interface SegmentOption<T extends string | number> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * A row of mutually exclusive presets. Each segment stays a real button with
 * aria-pressed, so its label is its accessible name; the hint rides along as
 * a tooltip and the row shows the selected one as its description.
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="st-segmented">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={active}
            title={option.hint}
            className={`st-segmented__item${active ? " is-active" : ""}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A slider with its value printed beside it, sized to sit in a row's control slot. */
export function RangeControl({
  ariaLabel,
  min,
  max,
  step,
  value,
  display,
  onChange,
  onCommit,
  onPointerDown,
}: {
  ariaLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (next: number) => void;
  /** Fires on release, blur and key-up for callers that persist once per gesture. */
  onCommit?: (next: number) => void;
  onPointerDown?: () => void;
}) {
  const commit = onCommit
    ? (event: React.SyntheticEvent<HTMLInputElement>) =>
        onCommit(Number(event.currentTarget.value))
    : undefined;
  return (
    <span className="st-range">
      <input
        aria-label={ariaLabel}
        aria-valuetext={display}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onPointerDown}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        onPointerUp={commit}
        onPointerCancel={commit}
        onBlur={commit}
        onKeyUp={commit}
      />
      <span className="st-range__value" aria-hidden>
        {display}
      </span>
    </span>
  );
}

/**
 * A stacked form field: a sentence-case label over its control, with an
 * optional hint under it. Wrapping in a <label> keeps getByLabel working for
 * both inputs and button-shaped controls. Inside a card, prefer a `stacked`
 * SettingRow; this is for forms that are not rows.
 */
export function Label({
  text,
  hint,
  hintAction,
  anchor,
  children,
}: {
  text: string;
  hint?: React.ReactNode;
  /** A button beside the hint, kept outside the <label> so it is never its target. */
  hintAction?: React.ReactNode;
  anchor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="st-field" data-setting-anchor={anchor ?? text}>
      <label className="st-field__label-wrap">
        <span className="st-field__label">{text}</span>
        {children}
      </label>
      {hint || hintAction ? (
        <div className={`st-field__hint${hintAction ? " st-field__hint--row" : ""}`}>
          <span>{hint}</span>
          {hintAction}
        </div>
      ) : null}
    </div>
  );
}

export function InlineMessage({
  tone,
  role,
  children,
  action,
}: {
  tone: "danger" | "warn" | "info" | "ok" | "muted";
  role?: "alert" | "status";
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={`st-message st-message--${tone}`} role={role}>
      <StatusGlyph tone={tone} />
      <span className="st-message__text">{children}</span>
      {action ? <span className="st-message__action">{action}</span> : null}
    </div>
  );
}

export function StatusGlyph({ tone }: { tone: "danger" | "warn" | "info" | "ok" | "muted" }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "st-glyph",
  };
  if (tone === "ok") {
    return (
      <svg {...common}>
        <path d="M5 12.5l4.5 4.5L19 7" />
      </svg>
    );
  }
  if (tone === "danger" || tone === "warn") {
    return (
      <svg {...common}>
        <path d="M12 4.5 21 19.5H3z" />
        <line x1="12" y1="10" x2="12" y2="14" />
        <circle cx="12" cy="16.9" r="0.4" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8.5" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="8" r="0.4" fill="currentColor" />
    </svg>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="st-empty">
      {icon ? <span className="st-empty__icon" aria-hidden>{icon}</span> : null}
      <span className="st-empty__title">{title}</span>
      {body ? <span className="st-empty__body">{body}</span> : null}
      {action ? <span className="st-empty__action">{action}</span> : null}
    </div>
  );
}

/** A label and a plain value, for read-only facts (versions, counts). */
export function ValueRow({
  title,
  desc,
  value,
  mono,
  anchor,
}: {
  title: string;
  desc?: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
  anchor?: string;
}) {
  return (
    <SettingRow
      title={title}
      desc={desc}
      anchor={anchor}
      control={<span className={`st-value${mono ? " is-mono" : ""}`}>{value}</span>}
    />
  );
}
