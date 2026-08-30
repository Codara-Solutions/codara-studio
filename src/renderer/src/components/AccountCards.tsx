import { useEffect, useRef, useState } from "react";
import { familyForRuntime } from "@shared/agent-families";
import type { PiSubscriptionProvider } from "@shared/types";
import { agentBrandColor } from "../lib/agent-brand";
import type { AccountProviderDescriptor } from "../lib/account-provider-descriptors";
import AnchoredMenu from "./chat/composer/AnchoredMenu";
import {
  ActionButton,
  BUTTON_STYLE,
  INPUT_STYLE,
  PRIMARY_BUTTON_STYLE,
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
  /** Short plain-language summary shown under the provider name. */
  detail: string;
  cards: AccountCardView[];
  /** Muted line under the cards, e.g. the account count. */
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
        className="spark-btn"
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
        style={{
          ...PRIMARY_BUTTON_STYLE,
          flex: "0 0 auto",
          ...(disabled ? { cursor: "default", opacity: 0.5 } : {}),
        }}
      >
        <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>+</span>
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
        <div style={{ width: 388, display: "grid", gap: 8, padding: 5 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: selectedProvider
                ? "26px minmax(0, 1fr) 26px"
                : "minmax(0, 1fr) 26px",
              alignItems: "start",
              gap: 7,
              padding: "3px 3px 5px",
            }}
          >
            {selectedProvider ? (
              <button
                type="button"
                className="spark-btn"
                aria-label="Back"
                onClick={back}
                style={{ ...BUTTON_STYLE, width: 26, minHeight: 26, padding: 0 }}
              >
                ←
              </button>
            ) : null}
            <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
              <span
                style={{
                  color: "var(--ink)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                {!selectedView
                  ? "Choose an agent"
                  : `Sign in to ${selectedFamily?.displayName}`}
              </span>
              <span
                style={{
                  color: "var(--muted)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 10.5,
                  lineHeight: 1.4,
                }}
              >
                {!selectedView
                  ? "Pick the account you want to connect."
                  : `Sign in once in your browser. Cora and ${selectedView.descriptor.cliLabel} both use it.`}
              </span>
            </div>
            <button
              type="button"
              className="spark-btn"
              aria-label="Close account picker"
              onClick={close}
              style={{
                ...BUTTON_STYLE,
                width: 26,
                minHeight: 26,
                padding: 0,
                color: "var(--muted)",
              }}
            >
              ×
            </button>
          </div>

          {!selectedView ? (
            <div
              role="listbox"
              aria-label="Agent"
              style={{ display: "grid", gap: 5 }}
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
                    className="spark-menu-item"
                    disabled={unavailable}
                    onClick={() => choose(view)}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "38px minmax(0, 1fr) auto",
                      alignItems: "center",
                      gap: 10,
                      minHeight: 54,
                      padding: "8px 10px",
                      textAlign: "left",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 36,
                        height: 36,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: 10,
                        color: brand,
                        border: `1px solid color-mix(in oklch, ${brand} 34%, transparent)`,
                        background: `color-mix(in oklch, ${brand} 14%, transparent)`,
                      }}
                    >
                      <RuntimeMark runtime={runtime} size={20} />
                    </span>
                    <span style={{ minWidth: 0, display: "grid", gap: 2 }}>
                      <span
                        style={{
                          color: "var(--ink)",
                          fontSize: 12.5,
                          fontWeight: 700,
                        }}
                      >
                        {family.displayName}
                      </span>
                      <span
                        style={{
                          color: "var(--muted)",
                          fontSize: 10.5,
                          lineHeight: 1.35,
                        }}
                      >
                        {label} · Cora and {cliLabel}
                      </span>
                    </span>
                    <span aria-hidden style={{ color: brand, fontSize: 18 }}>›</span>
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
              style={{ display: "grid", gap: 8, padding: "2px 3px 3px" }}
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
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 6,
                }}
              >
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
      style={{
        display: "grid",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
          <span
            id={`accounts-${descriptor.provider}-title`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 14,
              fontWeight: 700,
            }}
          >
            <span aria-hidden style={{ display: "inline-flex", color: brand }}>
              <RuntimeMark runtime={descriptor.runtime} size={16} />
            </span>
            {descriptor.label}
          </span>
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              lineHeight: 1.4,
            }}
          >
            {view.detail}
          </span>
        </div>
      </div>

      {view.cliError ? (
        <div
          role="alert"
          style={{
            color: "var(--danger)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
          }}
        >
          The {descriptor.cliLabel} sign-in status could not be loaded. Try again.
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 8 }}>
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
          <div
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              padding: "4px 2px",
            }}
          >
            No {descriptor.label} account yet.
          </div>
        ) : null}
        {view.footer ? (
          <div
            style={{
              color: "var(--muted-2, var(--muted))",
              fontFamily: "var(--font-sans)",
              fontSize: 10.5,
              padding: "0 2px",
            }}
          >
            {view.footer}
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
    <div style={{ display: "grid", gap: 18 }}>
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
