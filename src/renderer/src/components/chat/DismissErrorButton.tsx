// The close control on the chat's error banners (the panel's ErrorBar and the
// composer's alert).
export default function DismissErrorButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="cora-error-dismiss"
      aria-label="Dismiss error"
      title="Dismiss"
      onClick={onClick}
    >
      <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden>
        <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </button>
  );
}
