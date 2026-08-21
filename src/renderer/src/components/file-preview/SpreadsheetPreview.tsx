import { forwardRef, useEffect, useMemo, useState, type ReactNode } from "react";
import readExcelFile, { type SheetData } from "read-excel-file/browser";
import { TableVirtuoso, type TableComponents } from "react-virtuoso";
import { DockablePaneBar } from "../../tabs/dockChromeSlot";

interface Props {
  path: string;
  mtimeMs: number;
  toolbarAction?: ReactNode;
  forceLocalToolbar?: boolean;
}

interface SheetView {
  name: string;
  rows: SheetData;
  sourceRows: number;
  sourceColumns: number;
}

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_VISIBLE_ROWS = 10_000;
const MAX_VISIBLE_COLUMNS = 256;

// OOXML spreadsheets can contain hundreds of thousands of rows. Only visible
// rows are mounted, so scrolling remains light even when the workbook is not.
// Parsing is performed by read-excel-file's browser worker and this entire
// component is lazy-loaded by FilePreview, keeping Excel code off startup.
export default function SpreadsheetPreview({
  path,
  mtimeMs,
  toolbarAction,
  forceLocalToolbar,
}: Props) {
  const [sheets, setSheets] = useState<SheetView[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSheets([]);
    setActiveSheet(0);
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const stat = await window.spark.fs.statFile(path);
        if (stat.size > MAX_FILE_BYTES) {
          throw new Error(
            `This workbook is ${formatBytes(stat.size)}. Preview is limited to ${formatBytes(MAX_FILE_BYTES)} to protect app memory.`,
          );
        }
        const bytes = await window.spark.fs.readFileBytes(path);
        // The browser reader transfers its input to a worker. Give it an exact
        // standalone buffer so the IPC-backed Uint8Array cannot be detached.
        const buffer = bytes.slice().buffer as ArrayBuffer;
        const workbook = await readExcelFile(buffer);
        if (cancelled) return;
        setSheets(
          workbook.map(({ sheet, data }) => {
            const sourceColumns = data.reduce((max, row) => Math.max(max, row.length), 0);
            return {
              name: sheet,
              rows: data
                .slice(0, MAX_VISIBLE_ROWS)
                .map((row) => row.slice(0, MAX_VISIBLE_COLUMNS)),
              sourceRows: data.length,
              sourceColumns,
            };
          }),
        );
      } catch (reason: unknown) {
        if (!cancelled) setError((reason as Error)?.message ?? String(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, mtimeMs]);

  const sheet = sheets[activeSheet] ?? null;
  const visibleColumns = Math.min(sheet?.sourceColumns ?? 0, MAX_VISIBLE_COLUMNS);
  const columnIndexes = useMemo(
    () => Array.from({ length: visibleColumns }, (_, index) => index),
    [visibleColumns],
  );
  const truncated =
    sheet !== null &&
    (sheet.sourceRows > MAX_VISIBLE_ROWS || sheet.sourceColumns > MAX_VISIBLE_COLUMNS);

  return (
    <div style={hostStyle}>
      <DockablePaneBar forceLocal={forceLocalToolbar}>
        <span
          style={{
            marginRight: "auto",
            fontFamily: "var(--font-mono)",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {loading
            ? "Loading workbook…"
            : sheet
              ? `${sheet.sourceRows.toLocaleString()} × ${sheet.sourceColumns.toLocaleString()}`
              : "Workbook"}
        </span>
        {sheets.length > 1 ? (
          <label style={sheetPickerLabel}>
            <span>Sheet</span>
            <select
              value={activeSheet}
              onChange={(event) => setActiveSheet(Number(event.target.value))}
              aria-label="Spreadsheet sheet"
              style={sheetPicker}
            >
              {sheets.map((candidate, index) => (
                <option key={`${candidate.name}-${index}`} value={index}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          sheet && (
            <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>
              {sheet.name}
            </span>
          )
        )}
        {toolbarAction}
      </DockablePaneBar>

      {loading ? (
        <PreviewMessage label="Spreadsheet" detail="Reading cells…" />
      ) : error ? (
        <PreviewMessage label="Spreadsheet error" detail={error} danger />
      ) : !sheet || sheet.sourceRows === 0 || sheet.sourceColumns === 0 ? (
        <PreviewMessage label="Empty sheet" detail="This sheet has no cells to display." />
      ) : (
        <>
          {truncated && (
            <div style={limitNotice}>
              Showing the first {Math.min(sheet.sourceRows, MAX_VISIBLE_ROWS).toLocaleString()} rows
              and {Math.min(sheet.sourceColumns, MAX_VISIBLE_COLUMNS).toLocaleString()} columns.
            </div>
          )}
          <TableVirtuoso
            key={activeSheet}
            data={sheet.rows}
            components={tableComponents}
            fixedItemHeight={31}
            fixedHeaderContent={() => (
              <tr>
                <th
                  style={{ ...headerCell, ...rowNumberCell, top: 0, zIndex: 3 }}
                  aria-label="Row number"
                />
                {columnIndexes.map((column) => (
                  <th key={column} style={headerCell}>
                    {columnLabel(column)}
                  </th>
                ))}
              </tr>
            )}
            itemContent={(rowIndex, row) => (
              <>
                <th scope="row" style={rowNumberCell}>
                  {rowIndex + 1}
                </th>
                {columnIndexes.map((column) => {
                  const display = formatCell(row[column]);
                  return (
                    <td key={column} style={dataCell} title={display}>
                      {display}
                    </td>
                  );
                })}
              </>
            )}
            style={{ flex: 1, minHeight: 0 }}
          />
        </>
      )}
    </div>
  );
}

const SpreadsheetTable = forwardRef<
  HTMLTableElement,
  React.ComponentPropsWithoutRef<"table">
>(function SpreadsheetTable({ style, ...props }, ref) {
  return (
    <table
      {...props}
      ref={ref}
      style={{
        ...style,
        width: "max-content",
        minWidth: "100%",
        borderCollapse: "separate",
        borderSpacing: 0,
        tableLayout: "fixed",
      }}
    />
  );
});

const tableComponents: TableComponents<SheetData[number]> = {
  Table: SpreadsheetTable,
};

function PreviewMessage({
  label,
  detail,
  danger = false,
}: {
  label: string;
  detail: string;
  danger?: boolean;
}) {
  return (
    <div style={{ margin: "auto", maxWidth: 520, padding: 24, textAlign: "center", fontSize: 12 }}>
      <div
        className="spark-eyebrow"
        style={{ marginBottom: 7, color: danger ? "var(--danger)" : "var(--muted)" }}
      >
        {label}
      </div>
      <div style={{ color: danger ? "var(--danger)" : "var(--ink-dim)", lineHeight: 1.55 }}>
        {detail}
      </div>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const hasTime = value.getHours() !== 0 || value.getMinutes() !== 0 || value.getSeconds() !== 0;
    return hasTime ? value.toLocaleString() : value.toLocaleDateString();
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function columnLabel(index: number): string {
  let label = "";
  for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) {
    label = String.fromCharCode(65 + ((current - 1) % 26)) + label;
  }
  return label;
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

const hostStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  background: "var(--bg)",
};

const sheetPickerLabel: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  pointerEvents: "auto",
};

const sheetPicker: React.CSSProperties = {
  height: 24,
  maxWidth: 180,
  padding: "0 24px 0 8px",
  color: "var(--ink-dim)",
  background: "var(--panel-2)",
  border: "1px solid var(--rule)",
  borderRadius: 6,
  font: "inherit",
  outline: "none",
  pointerEvents: "auto",
};

const limitNotice: React.CSSProperties = {
  flex: "0 0 auto",
  padding: "5px 12px",
  color: "var(--warn)",
  background: "color-mix(in oklch, var(--warn) 8%, var(--panel))",
  borderBottom: "1px solid var(--rule-soft)",
  fontSize: 11,
  textAlign: "center",
};

const headerCell: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 2,
  boxSizing: "border-box",
  width: 144,
  height: 31,
  padding: "0 9px",
  color: "var(--muted)",
  background: "var(--panel-2)",
  borderRight: "1px solid var(--rule-soft)",
  borderBottom: "1px solid var(--rule)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 600,
  textAlign: "center",
};

const rowNumberCell: React.CSSProperties = {
  position: "sticky",
  left: 0,
  zIndex: 1,
  boxSizing: "border-box",
  width: 48,
  minWidth: 48,
  height: 31,
  padding: "0 8px",
  color: "var(--muted)",
  background: "var(--panel-2)",
  borderRight: "1px solid var(--rule)",
  borderBottom: "1px solid var(--rule-soft)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 500,
  textAlign: "right",
};

const dataCell: React.CSSProperties = {
  boxSizing: "border-box",
  width: 144,
  maxWidth: 144,
  height: 31,
  padding: "0 9px",
  overflow: "hidden",
  color: "var(--ink-dim)",
  background: "var(--bg)",
  borderRight: "1px solid var(--rule-soft)",
  borderBottom: "1px solid var(--rule-soft)",
  fontSize: 11,
  lineHeight: "30px",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
