import { forwardRef, type CSSProperties, type KeyboardEventHandler, type ReactNode } from "react";
import "./onboarding.css";

// The floating guide card: the onboarding tour shows it while you explore an
// area, and feature tips and their tours reuse it. It sits bottom right
// unless `style` places it.

interface Props {
  label: string;
  eyebrow: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  /** Below the actions, such as an error. */
  footer?: ReactNode;
  className?: string;
  style?: CSSProperties;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
}

export const OnboardingCoach = forwardRef<HTMLElement, Props>(function OnboardingCoach(
  { label, eyebrow, title, children, actions, footer, className, style, onKeyDown },
  ref,
) {
  return (
    <aside
      ref={ref}
      className={className ? `onboarding-coach ${className}` : "onboarding-coach"}
      style={style}
      aria-label={label}
      aria-live="polite"
      onKeyDown={onKeyDown}
    >
      <span className="onboarding-eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      {children}
      <div className="onboarding-actions">{actions}</div>
      {footer}
    </aside>
  );
});
