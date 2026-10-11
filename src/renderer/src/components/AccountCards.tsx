import { useEffect, useRef, useState } from "react";
import { familyForRuntime } from "@shared/agent-families";
import type { PiSubscriptionProvider } from "@shared/types";
import { agentBrandColor } from "../lib/agent-brand";
import type { AccountProviderDescriptor } from "../lib/account-provider-descriptors";
import AnchoredMenu from "./chat/composer/AnchoredMenu";
import {
  ActionButton,
  INPUT_STYLE,
  SETTINGS_MENU_Z,
} from "./AccountCardPrimitives";
import AccountCard, {
  type AccountCardActions,
  type AccountCardView,
} from "./AccountCard";
import { RuntimeMark } from "./BrandMarks";

/**
 * One provider group: the descriptor that names it, its cards, and the
 * state of the one sign-in flow every provider shares. A card is one account
 * with two halves paired in the main process (see AccountCard).
 */
export interface AccountProviderView {
  descriptor: AccountProviderDescriptor;
  /** One line under the provider name: what a switch moves. */
  summary: string;
  /** The full switching rules, shown under "How switching works". */
  detail: string;
  cards: AccountCardView[];
  /** Muted count beside the provider name, e.g. "2 of 4 ready". */
  footer?: string;
  /** Account actions are unavailable until the Pi runtime is installed. */
  disabled: boolean;
  /** A browser sign-in or account mutation is in flight. */
  busy: boolean;
  /** The terminal-side store could not be read, so its halves cannot show. */
  cliError: boolean;
  /** The name typed into the Add-account picker while this provider is selected. */
  addLabel: string;
}

export interface AccountActions extends AccountCardActions {
  onBeginAdd: (provider: PiSubscriptionProvider) => void;
  onAddLabel: (label: string) => void;
  /** Start the one sign-in that writes both halves of a new account. */
  onAdd: (provider: PiSubscriptionProvider) => void;
  onCancelAdd: () => void;
}

export function AccountAddPicker({
  providers,
  actions,
}: {
  providers: ReadonlyArray<AccountProviderView>;
  actions: AccountActions;
}) {
  const [open, setOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] =
    useState<PiSubscriptionProvider | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedView = providers.find(
    (view) => view.descriptor.provider === selectedProvider,
  );
  const selectedFamily = selectedView
    ? familyForRuntime(selectedView.descriptor.runtime)
    : null;
  // Every account is one browser sign-in that writes both halves, so the
  // picker has no destination step: choose the provider, then sign in.
  const providerDisabled = (view: AccountProviderView) => view.disabled || view.busy;
  const disabled = providers.every(providerDisabled);

  const close = () => {
    if (selectedProvider) actions.onCancelAdd();
    setOpen(false);
    setSelectedProvider(null);
  };

  const finish = () => {
    setOpen(false);
    setSelectedProvider(null);
  };

  const back = () => {
    actions.onCancelAdd();
    setSelectedProvider(null);
  };

  const choose = (view: AccountProviderView) => {
    setSelectedProvider(view.descriptor.provider);
    actions.onBeginAdd(view.descriptor.provider);
  };

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setSelectedProvider(null);
  }, [disabled]);

  const stage = selectedProvider ?? "provider";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="spark-btn st-acct-add"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Add an account"
        disabled={disabled}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          setSelectedProvider(null);
          setOpen(true);
        }}
      >
        <svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Add account
      </button>
      {/* Portalled because Settings' scrolling pane clips in-place popovers. */}
      <AnchoredMenu
        anchorRef={triggerRef}
        open={open}
        onClose={close}
        className="spark-menu"
        role="dialog"
        ariaLabel="Add an account"
        placement="below"
        align="end"
        focusSignal={stage}
        zIndex={SETTINGS_MENU_Z}
      >
        <div className="st-acct-picker">
          <div className="st-acct-picker__head">
            {selectedProvider ? (
              <button
                type="button"
                className="spark-icon-btn st-icon-btn"
                aria-label="Back"
                onClick={back}
              >
                <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
            ) : null}
            <div className="st-acct-picker__titles">
              <span className="st-acct-picker__title">
                {!selectedView
                  ? "Choose an agent"
                  : `Sign in to ${selectedFamily?.displayName}`}
              </span>
              <span className="st-acct-picker__sub">
                {!selectedView
                  ? "Pick the account you want to connect."
                  : `Sign in once in your browser. Cora and ${selectedView.descriptor.cliLabel} both use it.`}
              </span>
            </div>
            <button
              type="button"
              className="spark-icon-btn st-icon-btn"
              aria-label="Close account picker"
              onClick={close}
            >
              <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          {!selectedView ? (
            <div
              role="listbox"
              aria-label="Agent"
              className="st-acct-picker__list"
            >
              {providers.map((view) => {
                const { runtime, provider, label, cliLabel, brand: brandRuntime } =
                  view.descriptor;
                const family = familyForRuntime(runtime);
                const brand = agentBrandColor(brandRuntime);
                const unavailable = providerDisabled(view);
                return (
                  <button
                    key={provider}
                    type="button"
                    role="option"
                    aria-selected="false"
                    className="spark-menu-item st-acct-picker__option"
                    disabled={unavailable}
                    onClick={() => choose(view)}
                  >
                    <span
                      aria-hidden
                      className="st-acct-picker__mark"
                      style={{
                        color: brand,
                        background: `color-mix(in oklch, ${brand} 14%, transparent)`,
                      }}
                    >
                      <RuntimeMark runtime={runtime} size={18} />
                    </span>
                    <span className="st-acct-picker__option-text">
                      <span className="st-acct-picker__option-name">{family.displayName}</span>
                      <span className="st-acct-picker__option-sub">
                        {label} · Cora and {cliLabel}
                      </span>
                    </span>
                    <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="st-chevron">
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </button>
                );
              })}
            </div>
          ) : (
            <form
              aria-label={`Name for the new ${selectedFamily?.displayName} account`}
              onSubmit={(event) => {
                event.preventDefault();
                if (selectedView.disabled) return;
                actions.onAdd(selectedView.descriptor.provider);
                finish();
              }}
              className="st-acct-picker__form"
            >
              <input
                autoFocus
                aria-label={`Name for the new ${selectedFamily?.displayName} account`}
                className="spark-input"
                maxLength={80}
                placeholder="Account name (optional)"
                value={selectedView.addLabel}
                onChange={(event) => actions.onAddLabel(event.currentTarget.value)}
                style={INPUT_STYLE}
              />
              <div className="st-acct-picker__buttons">
                <ActionButton onClick={back}>Back</ActionButton>
                <button
                  type="submit"
                  className="spark-btn is-primary"
                  disabled={selectedView.disabled}
                >
                  Sign in
                </button>
              </div>
            </form>
          )}
        </div>
      </AnchoredMenu>
    </>
  );
}

function AccountProviderGroup({
  view,
  actions,
}: {
  view: AccountProviderView;
  actions: AccountActions;
}) {
  const { descriptor } = view;
  const brand = agentBrandColor(descriptor.brand);

  return (
    <section
      aria-labelledby={`accounts-${descriptor.provider}-title`}
      className="st-provider"
      data-setting-anchor={descriptor.label}
    >
      <div className="st-provider__head">
        <span id={`accounts-${descriptor.provider}-title`} className="st-provider__title">
          <span aria-hidden className="st-provider__mark" style={{ color: brand }}>
            <RuntimeMark runtime={descriptor.runtime} size={16} />
          </span>
          {descriptor.label}
        </span>
        {view.footer ? <span className="st-provider__count">{view.footer}</span> : null}
      </div>
      <p className="st-provider__detail">{view.summary}</p>

      {view.cliError ? (
        <div role="alert" className="st-acct-status st-acct-status--danger">
          The {descriptor.cliLabel} sign-in status could not be loaded. Try again.
        </div>
      ) : null}

      <div className="st-list st-acct-list">
        {view.cards.map((card) => (
          <AccountCard
            key={card.key}
            card={card}
            descriptor={descriptor}
            disabled={view.disabled || view.busy}
            actions={actions}
          />
        ))}
        {view.cards.length === 0 ? (
          <div className="st-acct-empty">
            <span aria-hidden className="st-acct-empty__mark" style={{ color: brand }}>
              <RuntimeMark runtime={descriptor.runtime} size={18} />
            </span>
            <span className="st-acct-empty__text">
              <span className="st-acct-empty__title">No {descriptor.label} account yet.</span>
              <span className="st-acct-empty__body">
                Sign in once and Cora and {descriptor.cliLabel} both use it.
              </span>
            </span>
            {/* view.busy covers any sign-in in flight, for every provider:
                only one browser login may run at a time. */}
            <span className="st-acct__actions">
              <ActionButton
                disabled={view.disabled || view.busy}
                onClick={() => actions.onAdd(descriptor.provider)}
              >
                Sign in to {descriptor.label}
              </ActionButton>
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default function AccountCards({
  providers,
  actions,
}: {
  providers: ReadonlyArray<AccountProviderView>;
  actions: AccountActions;
}) {
  return (
    <div className="st-providers">
      {providers.map((view) => (
        <AccountProviderGroup
          key={view.descriptor.provider}
          view={view}
          actions={actions}
        />
      ))}
    </div>
  );
}
