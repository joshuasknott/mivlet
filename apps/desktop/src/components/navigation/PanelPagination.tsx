import { CaretLeft } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";

/** Bound rendered collections without making search depend on the current page. */
export function PanelPagination({
  total,
  page,
  pageSize,
  onChange,
  label,
}: {
  total: number;
  page: number;
  pageSize: number;
  onChange: (page: number) => void;
  label: string;
}) {
  if (total <= pageSize) return null;
  const last = Math.max(0, Math.ceil(total / pageSize) - 1);
  const current = Math.min(page, last);
  return (
    <nav className="panel-pagination" aria-label={`${label} pages`}>
      <span aria-live="polite">
        {current * pageSize + 1}–{Math.min((current + 1) * pageSize, total)} of{" "}
        {total}
      </span>
      <div>
        <button
          type="button"
          aria-label={`Previous ${label.toLowerCase()} page`}
          disabled={current === 0}
          onClick={() => onChange(current - 1)}
        >
          <CaretLeft size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`Next ${label.toLowerCase()} page`}
          disabled={current === last}
          onClick={() => onChange(current + 1)}
        >
          <CaretRight size={16} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
