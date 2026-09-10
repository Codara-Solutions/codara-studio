import {
  forwardRef, useDeferredValue, useEffect, useId, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type ReactNode,
} from "react";
import { TableVirtuoso, type TableComponents, type TableVirtuosoHandle } from "react-virtuoso";
import {
  compareCsvCells, csvColumnLabel, CSV_COLUMN_LIMIT, CSV_ROW_LIMIT, isCsvNumber,
  replaceCsvCell, resolveCsv, type CsvDelimiter,
} from "./csv";
import "./csv.css";

interface ViewSettings {
  delimiter: CsvDelimiter;
  header: boolean;
  density: "compact" | "comfortable" | "spacious";
  fontSize: number;
  wrap: boolean;
  stripes: boolean;
  rowNumbers: boolean;
  freeze: boolean;
  hidden: number[];
  widths: Record<number, number>;
}

const defaults: ViewSettings = {
  delimiter: "auto", header: true, density: "comfortable", fontSize: 12,
  wrap: false, stripes: true, rowNumbers: true, freeze: false, hidden: [], widths: {},
};
const STORAGE_KEY = "spark.csv.views.v1";
const separators: { value: CsvDelimiter; label: string }[] = [
  { value: "auto", label: "Auto-detect" }, { value: ",", label: "Comma (,)" },
  { value: ";", label: "Semicolon (;)" }, { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe (|)" },
];

function readSettings(path: string): ViewSettings {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")[path];
    if (!value || typeof value !== "object") return defaults;
    const result = { ...defaults };
    for (const key of ["header", "wrap", "stripes", "rowNumbers", "freeze"] as const) {
      if (typeof value[key] === "boolean") result[key] = value[key];
    }
    if (separators.some((option) => option.value === value.delimiter)) result.delimiter = value.delimiter;
    if (["compact", "comfortable", "spacious"].includes(value.density)) result.density = value.density;
    if (Number.isInteger(value.fontSize) && value.fontSize >= 11 && value.fontSize <= 16) result.fontSize = value.fontSize;
    if (Array.isArray(value.hidden)) {
      result.hidden = [...new Set<number>(value.hidden.filter((index: unknown) =>
        typeof index === "number" && Number.isInteger(index) && index >= 0 && index < CSV_COLUMN_LIMIT))];
    }
    if (value.widths && typeof value.widths === "object") {
      result.widths = {};
      for (const [key, width] of Object.entries(value.widths)) {
        if (/^\d+$/.test(key) && Number(key) < CSV_COLUMN_LIMIT && typeof width === "number" && width >= 80 && width <= 640) {
          result.widths[Number(key)] = width;
        }
      }
    }
    return result;
  } catch { return defaults; }
}

type DataRow = { cells: string[]; index: number };
type Selection = { row: number; column: number };
interface CellEdit {
  target: Selection;
  record: number;
  draft: string;
  source: string;
  parsed: ReturnType<typeof resolveCsv>;
}

export default function CsvPreview({ path, text, onChange, dirty, onSave }: {
  path: string;
  text: string;
  onChange: (text: string) => void;
  dirty: boolean;
  onSave: () => Promise<void>;
}) {
  const [settings, setSettings] = useState(() => readSettings(path));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sort, setSort] = useState<{ column: number; direction: 1 | -1 } | null>(null);
  const { hidden, widths } = settings;
  const setHidden = (next: number[] | ((current: number[]) => number[])) => {
    setSettings((current) => ({ ...current, hidden: typeof next === "function" ? next(current.hidden) : next }));
  };
  const setWidths = (next: Record<number, number> | ((current: Record<number, number>) => Record<number, number>)) => {
    setSettings((current) => ({ ...current, widths: typeof next === "function" ? next(current.widths) : next }));
  };
  const [selection, setSelection] = useState<Selection | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [edit, setEdit] = useState<CellEdit | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const tableRef = useRef<TableVirtuosoHandle>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<Selection | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsId = useId();
  const parsed = useMemo(() => resolveCsv(text, path, settings.delimiter), [text, path, settings.delimiter]);
  const columnCount = Math.min(parsed.sourceColumns, CSV_COLUMN_LIMIT);
  const columns = useMemo(() => Array.from({ length: columnCount }, (_, index) => ({
    index,
    name: settings.header ? parsed.rows[0]?.[index] || `Column ${csvColumnLabel(index)}` : `Column ${csvColumnLabel(index)}`,
  })), [parsed, settings.header, columnCount]);
  const visibleColumns = columns.filter((column) => !hidden.includes(column.index));
  const data = useMemo(() => parsed.rows.slice(settings.header ? 1 : 0, CSV_ROW_LIMIT + (settings.header ? 1 : 0))
    .map((cells, index) => ({ cells, index })), [parsed, settings.header]);
  const rows = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    const result = needle ? data.filter((row) => row.cells.some((cell) => cell.toLocaleLowerCase().includes(needle))) : [...data];
    if (sort) result.sort((a, b) => {
      const left = a.cells[sort.column] ?? "", right = b.cells[sort.column] ?? "";
      // Empty cells stay at the end in either direction.
      if (!left.trim() || !right.trim()) return compareCsvCells(left, right);
      return compareCsvCells(left, right) * sort.direction;
    });
    return result;
  }, [data, deferredQuery, sort]);
  const sourceRows = Math.max(0, parsed.sourceRows - (settings.header && parsed.sourceRows ? 1 : 0));
  const truncated = parsed.truncated || sourceRows > CSV_ROW_LIMIT;
  const selectedRow = selection ? data[selection.row] : null;
  const selectedValue = selection ? selectedRow?.cells[selection.column] ?? "" : "";
  const hasSelection = !!edit || (!!selection && !!selectedRow && !hidden.includes(selection.column)
    && rows.some((row) => row.index === selection.row));
  const baseWidths = useMemo(() => Object.fromEntries(columns.map((column) => {
    const lengths = data.slice(0, 80).map((row) => (row.cells[column.index] ?? "").length);
    const length = Math.max(column.name.length + 6, ...lengths, 8);
    return [column.index, Math.min(320, Math.max(130, length * settings.fontSize * 0.59 + 32))];
  })), [columns, data, settings.fontSize]);
  const widthFor = (column: number) => widths[column] ?? baseWidths[column] ?? 160;
  const rowHeight = { compact: 29, comfortable: 37, spacious: 47 }[settings.density];
  const firstVisible = visibleColumns[0]?.index;
  const totalWidth = visibleColumns.reduce((sum, column) => sum + widthFor(column.index), settings.rowNumbers ? 52 : 0);
  const delimiterLabel = separators.find((option) => option.value === parsed.delimiter)?.label ?? "Comma (,)";
  const schema = `${settings.delimiter}:${parsed.delimiter}:${settings.header}:${columnCount}`;
  const schemaRef = useRef(schema);
  const mismatch = parsed.rows.some((row) => row.length !== parsed.rows[0]?.length);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      const entries = Object.entries(stored && typeof stored === "object" ? stored : {}).filter(([key]) => key !== path).slice(-29);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries([...entries, [path, settings]])));
    } catch { /* Storage may be unavailable in a restricted renderer. */ }
  }, [settings, path]);

  useEffect(() => {
    if (schemaRef.current === schema) return;
    schemaRef.current = schema;
    setSort(null);
    if (!edit) setSelection(null);
    setSettings((current) => ({ ...current, hidden: [], widths: {} }));
  }, [schema]);

  useEffect(() => {
    // A source edit can remove every column that was visible when last saved.
    if (columnCount && Array.from({ length: columnCount }, (_, index) => index).every((index) => hidden.includes(index))) {
      setSettings((current) => ({ ...current, hidden: [] }));
    }
  }, [columnCount, hidden]);

  useEffect(() => {
    if (!copyStatus) return;
    const timer = window.setTimeout(() => setCopyStatus(""), 2200);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  const update = <K extends keyof ViewSettings>(key: K, value: ViewSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };
  const closeSettings = () => { setSettingsOpen(false); settingsButtonRef.current?.focus(); };
  const cellClass = (column: number) => settings.freeze && column === firstVisible ? " csv-frozen" : "";
  const applyEdit = (): boolean => {
    if (!edit) return true;
    if (edit.source !== text) {
      setEditError("The file changed while you were editing. Copy your value, then cancel and reopen the cell.");
      return false;
    }
    try {
      const next = replaceCsvCell(text, edit.parsed, edit.record, edit.target.column, edit.draft);
      if (next !== text) onChange(next);
      setEdit(null);
      setEditError(null);
      return true;
    } catch (reason) {
      setEditError((reason as Error).message);
      return false;
    }
  };
  const saveChanges = async () => {
    if (saving || !applyEdit()) return;
    setSaving(true);
    setSaveError(null);
    try { await onSave(); }
    catch (reason) { setSaveError(`Could not save: ${(reason as Error).message}`); }
    finally { setSaving(false); }
  };
  const chooseCell = (target: Selection) => {
    if (edit && (edit.target.row !== target.row || edit.target.column !== target.column) && !applyEdit()) return;
    setSelection(target);
    setCopyStatus("");
  };
  const beginEdit = (target: Selection | null = selection) => {
    if (!target || parsed.malformed || edit) return;
    setSelection(target);
    setEditError(null);
    setEdit({ target, record: target.row + (settings.header ? 1 : 0),
      draft: data[target.row]?.cells[target.column] ?? "", source: text, parsed });
  };
  const restoreSelectionFocus = () => {
    pendingFocus.current = selection;
    gridRef.current?.focus({ preventScroll: true });
    requestAnimationFrame(focusPendingCell);
  };
  const cancelEdit = () => { setEdit(null); setEditError(null); restoreSelectionFocus(); };
  const focusPendingCell = () => {
    const target = pendingFocus.current;
    if (!target) return;
    const cell = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${target.row}:${target.column}"]`);
    if (!cell) return;
    pendingFocus.current = null;
    cell.focus({ preventScroll: true });
    cell.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const onTableKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || (event.target.tagName !== "TD" && event.target !== event.currentTarget)) return;
    if (!rows.length || !visibleColumns.length) return;
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      beginEdit();
      return;
    }
    const position = selection ? rows.findIndex((row) => row.index === selection.row) : 0;
    const columnPosition = selection ? visibleColumns.findIndex((column) => column.index === selection.column) : 0;
    let nextRow = Math.max(position, 0), nextColumn = Math.max(columnPosition, 0);
    if (event.key === "ArrowDown") nextRow++;
    else if (event.key === "ArrowUp") nextRow--;
    else if (event.key === "ArrowRight") nextColumn++;
    else if (event.key === "ArrowLeft") nextColumn--;
    else return;
    event.preventDefault();
    nextRow = Math.max(0, Math.min(rows.length - 1, nextRow));
    nextColumn = Math.max(0, Math.min(visibleColumns.length - 1, nextColumn));
    const target = { row: rows[nextRow].index, column: visibleColumns[nextColumn].index };
    pendingFocus.current = target;
    setSelection(target);
    // Keep receiving arrow keys while virtualization mounts the target row.
    event.currentTarget.focus({ preventScroll: true });
    tableRef.current?.scrollIntoView({ index: nextRow, done: () => requestAnimationFrame(focusPendingCell) });
    requestAnimationFrame(focusPendingCell);
  };

  return (
    <section className="csv-view" aria-label="CSV table viewer" onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        void saveChanges();
      }
    }} style={{
      "--csv-font-size": `${settings.fontSize}px`, "--csv-row-height": `${rowHeight}px`,
      "--csv-number-width": settings.rowNumbers ? "52px" : "0px",
    } as CSSProperties}>
      <div className="csv-heading">
        <div className="csv-file-icon"><CsvIcon name="table" size={21} /></div>
        <div className="csv-heading-text">
          <div className="csv-eyebrow">DATA EXPLORER</div>
          <h2 title={path}>{path.replace(/\\/g, "/").split("/").pop()}</h2>
        </div>
        <div className="csv-summary"><strong>{sourceRows.toLocaleString()}</strong> rows <span>·</span> <strong>{parsed.sourceColumns.toLocaleString()}</strong> columns</div>
      </div>
      <div className="csv-toolbar">
        <label className="csv-search"><CsvIcon name="search" />
          <input aria-label="Search CSV" placeholder="Search all columns…" value={query} onChange={(event) => setQuery(event.target.value)} />
          {query && <button type="button" className="csv-icon-button" aria-label="Clear search" onClick={() => setQuery("")}><CsvIcon name="close" size={13} /></button>}
        </label>
        {sort && <button className="csv-button csv-sort-reset" onClick={() => setSort(null)} title="Restore original row order"><CsvIcon name="sort" />Clear sort</button>}
        <button className="csv-button csv-fit" onClick={() => setWidths({})} title="Fit columns to their contents"><CsvIcon name="fit" />Fit columns</button>
        {(dirty || edit || saving || saveError) && <button className="csv-button is-active" disabled={saving} onClick={() => void saveChanges()}>{saving ? "Saving…" : "Save file"}</button>}
        <button ref={settingsButtonRef} className={`csv-button${settingsOpen ? " is-active" : ""}`} aria-expanded={settingsOpen} aria-controls={settingsId} onClick={() => setSettingsOpen(!settingsOpen)}><CsvIcon name="settings" />View settings</button>
      </div>
      {saveError && <div className="csv-notice" role="alert">{saveError}</div>}
      {(parsed.malformed || truncated || mismatch) && <div className="csv-notice" role="status">
        {parsed.malformed ? "Some quotes are incomplete or unexpected. Check Source if values look misaligned. " : ""}
        {truncated ? `Preview limited to ${CSV_ROW_LIMIT.toLocaleString()} rows and ${CSV_COLUMN_LIMIT} columns. Search and sorting apply to this preview. ` : ""}
        {mismatch && !parsed.malformed ? "Rows have different column counts. Missing cells are shown empty." : ""}
      </div>}
      <div className="csv-body">
        <div ref={gridRef} tabIndex={-1} className={`csv-grid${settings.stripes ? " csv-striped" : ""}${settings.wrap ? " csv-wrapped" : ""}`} onKeyDown={onTableKeyDown}>
          {columnCount === 0 ? <EmptyState title="A clean slate" detail="This file is empty. Add data in Source to see it here." />
            : rows.length === 0 ? <EmptyState title={query ? "No matching rows" : "Just the headers"} detail={query ? "Try another search. All columns are included, even hidden ones." : "This file has column names but no data rows."} action={query ? <button className="csv-button" onClick={() => setQuery("")}>Clear search</button> : undefined} />
            : <TableVirtuoso
              ref={tableRef}
              key={`${settings.density}-${settings.wrap}-${settings.fontSize}`}
              data={rows}
              computeItemKey={(_, row) => row.index}
              rangeChanged={() => requestAnimationFrame(focusPendingCell)}
              components={tableComponents}
              defaultItemHeight={rowHeight}
              fixedItemHeight={settings.wrap ? undefined : rowHeight}
              style={{ height: "100%", width: "100%", "--csv-table-width": `${totalWidth}px` } as CSSProperties}
              fixedHeaderContent={() => <tr>
                {settings.rowNumbers && <th className="csv-row-number csv-corner" scope="col" aria-label="Row number">#</th>}
                {visibleColumns.map((column) => <th key={column.index} scope="col" className={cellClass(column.index)} style={{ width: widthFor(column.index) }} aria-sort={sort?.column === column.index ? sort.direction === 1 ? "ascending" : "descending" : "none"}>
                  <button className="csv-column-button" aria-label={`Sort by ${column.name}`} title={`Sort by ${column.name}`} onClick={() => setSort((current) => current?.column === column.index ? current.direction === 1 ? { column: column.index, direction: -1 } : null : { column: column.index, direction: 1 })}>
                    <span className="csv-column-letter">{csvColumnLabel(column.index)}</span><span className="csv-column-name">{column.name}</span>
                    <span className={`csv-sort-icon${sort?.column === column.index ? " is-active" : ""}`}>{sort?.column === column.index ? sort.direction === 1 ? "↑" : "↓" : "↕"}</span>
                  </button>
                  <div className="csv-resize" role="separator" aria-label={`Resize ${column.name}`} aria-orientation="vertical" aria-valuemin={80} aria-valuemax={640} aria-valuenow={Math.round(widthFor(column.index))} tabIndex={0}
                    onDoubleClick={() => setWidths((current) => ({ ...current, [column.index]: baseWidths[column.index] }))}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                      event.preventDefault();
                      setWidths((current) => ({ ...current, [column.index]: Math.max(80, Math.min(640, widthFor(column.index) + (event.key === "ArrowRight" ? 16 : -16))) }));
                    }}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      event.currentTarget.dataset.startX = String(event.clientX);
                      event.currentTarget.dataset.startWidth = String(widthFor(column.index));
                    }}
                    onPointerMove={(event) => {
                      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                      const width = Number(event.currentTarget.dataset.startWidth) + event.clientX - Number(event.currentTarget.dataset.startX);
                      setWidths((current) => ({ ...current, [column.index]: Math.max(80, Math.min(640, width)) }));
                    }}
                    onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
                  />
                </th>)}
              </tr>}
              itemContent={(_, row) => <>
                {settings.rowNumbers && <th scope="row" className="csv-row-number">{row.index + 1}</th>}
                {visibleColumns.map((column, position) => {
                  const value = row.cells[column.index] ?? "";
                  const selected = selection?.row === row.index && selection.column === column.index;
                  return <td key={column.index} data-cell={`${row.index}:${column.index}`} className={`${cellClass(column.index)}${selected ? " csv-selected" : ""}${isCsvNumber(value) ? " csv-number" : ""}`}
                    tabIndex={selected || (!hasSelection && row.index === rows[0]?.index && position === 0) ? 0 : -1}
                    onFocus={() => chooseCell({ row: row.index, column: column.index })}
                    onClick={(event) => { chooseCell({ row: row.index, column: column.index }); event.currentTarget.focus(); }}
                    onDoubleClick={() => beginEdit({ row: row.index, column: column.index })}
                    title={value || "Empty cell"}>
                    <div className="csv-cell-value">{value ? <HighlightedValue value={value} query={deferredQuery} /> : <span className="csv-empty-cell">∅</span>}</div>
                  </td>;
                })}
              </>}
            />}
        </div>
        {settingsOpen && <aside id={settingsId} className="csv-settings" aria-label="CSV view settings" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeSettings(); } }}>
          <div className="csv-settings-heading"><div><h3>Make it your view</h3><p>Saved for this file</p></div><button className="csv-icon-button" aria-label="Close view settings" onClick={closeSettings}><CsvIcon name="close" /></button></div>
          <div className="csv-settings-scroll">
            <fieldset><legend>APPEARANCE</legend>
              <span className="csv-setting-label">Row density</span>
              <div className="csv-density" role="group" aria-label="Row density">{(["compact", "comfortable", "spacious"] as const).map((density) => <button key={density} aria-pressed={settings.density === density} title={density} onClick={() => update("density", density)}>{density === "comfortable" ? "Regular" : density === "compact" ? "Compact" : "Roomy"}</button>)}</div>
              <label className="csv-font-label">Text size <output>{settings.fontSize} px</output><input aria-label="Text size" type="range" min={11} max={16} value={settings.fontSize} onChange={(event) => update("fontSize", Number(event.target.value))} /></label>
              <Toggle label="Wrap cell text" checked={settings.wrap} onChange={(value) => update("wrap", value)} />
              <Toggle label="Alternating row colors" checked={settings.stripes} onChange={(value) => update("stripes", value)} />
              <Toggle label="Row numbers" checked={settings.rowNumbers} onChange={(value) => update("rowNumbers", value)} />
              <Toggle label="Freeze first visible column" checked={settings.freeze} onChange={(value) => update("freeze", value)} />
            </fieldset>
            <fieldset disabled={!!edit}><legend>FILE INTERPRETATION</legend>
              <label className="csv-separator-label">Separator<select aria-label="CSV separator" value={settings.delimiter} onChange={(event) => update("delimiter", event.target.value as CsvDelimiter)}>{separators.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <Toggle label="First row is a header" checked={settings.header} onChange={(value) => update("header", value)} />
              <p className="csv-help">Display settings do not change your file.</p>
            </fieldset>
            {columns.length > 0 && <fieldset disabled={!!edit}><legend>COLUMNS <span>{visibleColumns.length}/{columns.length}</span></legend>
              {hidden.length > 0 && <button className="csv-text-button" onClick={() => setHidden([])}>Show all columns</button>}
              {columns.map((column) => <label className="csv-column-toggle" key={column.index}><input type="checkbox" checked={!hidden.includes(column.index)} disabled={visibleColumns.length === 1 && !hidden.includes(column.index)} onChange={(event) => setHidden((current) => event.target.checked ? current.filter((index) => index !== column.index) : [...current, column.index])} /><span className="csv-column-letter">{csvColumnLabel(column.index)}</span><span title={column.name}>{column.name}</span></label>)}
            </fieldset>}
            <button className="csv-button csv-reset" disabled={!!edit} onClick={() => { setSettings(defaults); setHidden([]); setWidths({}); setSort(null); }}>Reset view settings</button>
          </div>
        </aside>}
      </div>
      {hasSelection && selection && <div className={`csv-inspector${edit ? " csv-inspector-editing" : ""}`}>
        <div className="csv-inspector-heading">
          <span className="csv-cell-address">{csvColumnLabel(selection.column)}{selection.row + (settings.header ? 2 : 1)}</span>
          <strong>{columns[selection.column]?.name}</strong>
          <span>{(edit?.draft ?? selectedValue).length.toLocaleString()} characters</span>
          {edit ? <>
            <button className="csv-button" onClick={cancelEdit}>Cancel</button>
            <button className="csv-button is-active" onClick={() => { if (applyEdit()) restoreSelectionFocus(); }}>Apply change</button>
          </> : <>
            <button className="csv-button" disabled={parsed.malformed} title={parsed.malformed ? "Correct the quotes in Source before editing cells" : "Edit cell (Enter or double-click)"} onClick={() => beginEdit()}>Edit cell</button>
            <button className="csv-button" onClick={() => {
              void window.spark.clipboard.writeText(selectedValue).then(() => setCopyStatus("Copied")).catch(() => setCopyStatus("Copy failed"));
            }}>{copyStatus || "Copy cell"}</button>
            <button className="csv-icon-button" aria-label="Close cell inspector" onClick={() => setSelection(null)}><CsvIcon name="close" size={14} /></button>
          </>}
        </div>
        {edit ? <>
          <textarea autoFocus className="csv-cell-editor" aria-label="Edit selected cell" value={edit.draft}
            onChange={(event) => setEdit({ ...edit, draft: event.target.value })}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (applyEdit()) restoreSelectionFocus();
              }
            }} />
          {editError ? <div className="csv-edit-error" role="alert">{editError}</div>
            : <div className="csv-edit-help">Enter to apply · Shift+Enter for a new line · Esc to cancel</div>}
        </> : <div className="csv-inspector-value">{selectedValue || <span className="csv-help">Empty cell</span>}</div>}
        <span className="csv-sr-only" role="status">{copyStatus}</span>
      </div>}
      <footer className="csv-footer"><span className="csv-live-dot" /><span role="status">{query ? `${rows.length.toLocaleString()} of ${data.length.toLocaleString()} rows match` : `${data.length.toLocaleString()} rows in view`}</span><span className="csv-footer-spacer" /><span>{delimiterLabel}</span><span className="csv-footer-hint">Double-click a cell to edit</span></footer>
    </section>
  );
}

const CsvTable = forwardRef<HTMLTableElement, React.ComponentPropsWithoutRef<"table">>(function CsvTable({ style, ...props }, ref) {
  return <table {...props} ref={ref} style={{ ...style, width: "var(--csv-table-width)", tableLayout: "fixed", borderCollapse: "separate", borderSpacing: 0 }} />;
});
const tableComponents: TableComponents<DataRow> = { Table: CsvTable };

function HighlightedValue({ value, query }: { value: string; query: string }) {
  const needle = query.trim().toLocaleLowerCase();
  const index = needle ? value.toLocaleLowerCase().indexOf(needle) : -1;
  if (index < 0) return <>{value}</>;
  return <>{value.slice(0, index)}<mark>{value.slice(index, index + needle.length)}</mark>{value.slice(index + needle.length)}</>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="csv-toggle"><span>{label}</span><input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span className="csv-switch" aria-hidden="true" /></label>;
}

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="csv-empty-state"><div className="csv-empty-icon"><CsvIcon name="table" size={28} /></div><h3>{title}</h3><p>{detail}</p>{action}</div>;
}

function CsvIcon({ name, size = 15 }: { name: "table" | "search" | "close" | "settings" | "sort" | "fit"; size?: number }) {
  const paths: Record<typeof name, ReactNode> = {
    table: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 10h18M9 10v10M15 10v10" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    settings: <><path d="M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10" /><circle cx="12" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="8" cy="18" r="2" /></>,
    sort: <path d="M8 4v16m-4-4 4 4 4-4M16 20V4m-4 4 4-4 4 4" />,
    fit: <path d="M3 4v16M21 4v16M5 12h14M8 9l-3 3 3 3m8-6 3 3-3 3" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
