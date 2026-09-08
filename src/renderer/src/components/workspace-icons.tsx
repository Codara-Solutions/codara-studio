// Workspace icon library. Every glyph is a hand-drawn 24×24 stroke path so the
// set renders identically in the rail tile, the switch HUD, and the picker
// without pulling an icon package into the bundle. Ids are stable and stored
// on `Workspace.icon`; renaming one here would silently reset every workspace
// that chose it, so treat ids as persisted API.

export type WorkspaceIconCategory =
  | "dev"
  | "cloud"
  | "data"
  | "product"
  | "business"
  | "creative"
  | "science"
  | "life"
  | "fun"
  | "shapes";

export interface WorkspaceIconDef {
  id: string;
  label: string;
  category: WorkspaceIconCategory;
  keywords: string[];
  /** SVG inner markup for a 24×24 viewBox, stroke-only. */
  path: string;
}

export const DEFAULT_WORKSPACE_ICON = "folder";

export const WORKSPACE_ICON_CATEGORIES: { id: WorkspaceIconCategory | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "dev", label: "Dev" },
  { id: "cloud", label: "Cloud" },
  { id: "data", label: "Data" },
  { id: "product", label: "Product" },
  { id: "business", label: "Business" },
  { id: "creative", label: "Creative" },
  { id: "science", label: "Science" },
  { id: "life", label: "Life" },
  { id: "fun", label: "Fun" },
  { id: "shapes", label: "Shapes" },
];

const D = (
  id: string,
  label: string,
  category: WorkspaceIconCategory,
  path: string,
  keywords: string[] = [],
): WorkspaceIconDef => ({ id, label, category, keywords, path });

export const WORKSPACE_ICONS: WorkspaceIconDef[] = [
  // ── dev ────────────────────────────────────────────────────────────────
  D("folder", "Folder", "dev", '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', ["directory", "default"]),
  D("terminal", "Terminal", "dev", '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>', ["shell", "cli", "console"]),
  D("code", "Code", "dev", '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 4l-4 16"/>', ["brackets", "source"]),
  D("branch", "Branch", "dev", '<path d="M6 3v12M18 9a3 3 0 0 1-3 3H9a3 3 0 0 0-3 3"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/>', ["git", "fork"]),
  D("commit", "Commit", "dev", '<circle cx="12" cy="12" r="3"/><path d="M3 12h6M15 12h6"/>', ["git", "node"]),
  D("bug", "Bug", "dev", '<path d="M8 9a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0z"/><path d="M12 14v6M8 6l-2-2M16 6l2-2M4 12h4M16 12h4M5 19l3-2M19 19l-3-2"/>', ["debug", "issue", "insect"]),
  D("package", "Package", "dev", '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>', ["box", "npm", "module"]),
  D("cpu", "Chip", "dev", '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>', ["processor", "hardware", "os"]),
  D("layers", "Layers", "dev", '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5M3 17l9 5 9-5"/>', ["stack", "layer"]),
  D("plug", "Plugin", "dev", '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>', ["extension", "connector", "integration"]),
  D("bot", "Bot", "dev", '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M2 13h3M19 13h3"/>', ["robot", "agent", "ai", "assistant"]),
  D("brain", "Brain", "dev", '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h3V4zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3h-3V4z"/>', ["ai", "model", "llm", "mind"]),
  D("wrench", "Wrench", "dev", '<path d="M14 4a5 5 0 0 0 6 6l-9 9a2.5 2.5 0 0 1-4-4l9-9z"/>', ["tool", "fix", "settings"]),
  D("hammer", "Hammer", "dev", '<path d="M14 6l4 4-9 9-4-4z"/><path d="M12 4l6 6 3-3-6-6z"/>', ["build", "tool"]),
  D("sliders", "Sliders", "dev", '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>', ["settings", "config", "controls"]),
  D("shield", "Shield", "dev", '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>', ["security", "auth", "protect"]),
  D("key", "Key", "dev", '<circle cx="8" cy="14" r="4"/><path d="M11 11l9-9M16 6l2 2M13 9l2 2"/>', ["auth", "secret", "token", "password"]),
  D("lock", "Lock", "dev", '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', ["private", "secure"]),
  D("puzzle", "Puzzle", "dev", '<path d="M10 3a2 2 0 0 1 4 0v2h4v4a2 2 0 0 1 0 4v4h-4v-2a2 2 0 0 0-4 0v2H6v-4a2 2 0 0 1 0-4V5h4z"/>', ["piece", "plugin", "component"]),
  D("test", "Test", "dev", '<path d="M9 3v7L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-5-9V3"/><path d="M8 3h8M7 15h10"/>', ["lab", "flask", "experiment", "testing"]),
  // ── cloud ──────────────────────────────────────────────────────────────
  D("cloud", "Cloud", "cloud", '<path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 6.5 19z"/>', ["hosting", "deploy", "saas"]),
  D("cloud-up", "Cloud upload", "cloud", '<path d="M17.5 17a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 6.5 17"/><path d="M12 12v9M9 15l3-3 3 3"/>', ["deploy", "publish", "sync"]),
  D("cloud-bolt", "Cloud bolt", "cloud", '<path d="M17.5 16a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 6.5 16"/><path d="M13 12l-2 4h3l-2 4"/>', ["serverless", "function", "lambda"]),
  D("server", "Server", "cloud", '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>', ["backend", "infra", "host", "vps"]),
  D("globe", "Globe", "cloud", '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>', ["web", "world", "site", "internet"]),
  D("network", "Network", "cloud", '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v5M12 12l-6 5M12 12l6 5"/>', ["mesh", "nodes", "graph"]),
  D("satellite", "Satellite", "cloud", '<path d="M13 7l4 4-6 6-4-4z"/><path d="M15 5l4 4M5 15l4 4M17 11l3-3M11 17l-3 3M3 21a4 4 0 0 1 4-4"/>', ["remote", "signal", "ssh"]),
  D("wifi", "Wifi", "cloud", '<path d="M5 12a10 10 0 0 1 14 0M8 15a6 6 0 0 1 8 0M2 9a14 14 0 0 1 20 0"/><circle cx="12" cy="18" r="1"/>', ["wireless", "signal"]),
  D("container", "Container", "cloud", '<rect x="3" y="7" width="18" height="12" rx="1.5"/><path d="M7 7v12M11 7v12M15 7v12M3 11h18M3 15h18"/>', ["docker", "kubernetes", "pod"]),
  D("link", "Link", "cloud", '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>', ["url", "chain", "connect"]),
  // ── data ───────────────────────────────────────────────────────────────
  D("database", "Database", "data", '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>', ["db", "sql", "postgres", "storage"]),
  D("chart", "Bar chart", "data", '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>', ["analytics", "stats", "metrics", "report"]),
  D("chart-line", "Line chart", "data", '<path d="M3 20h18M4 16l5-6 4 3 7-8"/>', ["trend", "growth", "graph"]),
  D("pie", "Pie chart", "data", '<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M12 3v9h9a9 9 0 0 0-9-9z"/>', ["share", "segment"]),
  D("table", "Table", "data", '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 10h18M3 15h18M9 5v14M15 5v14"/>', ["grid", "sheet", "spreadsheet"]),
  D("report", "Report", "data", '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>', ["document", "file", "paper", "brand"]),
  D("archive", "Archive", "data", '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>', ["box", "storage", "backup"]),
  D("search", "Search", "data", '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', ["find", "lookup", "research"]),
  D("filter", "Filter", "data", '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>', ["funnel", "pipeline"]),
  D("hdd", "Disk", "data", '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 15h18M7 18h.01M11 18h2"/>', ["drive", "storage", "files"]),
  // ── product ────────────────────────────────────────────────────────────
  D("rocket", "Rocket", "product", '<path d="M5 15c-2 2-2 5-2 5s3 0 5-2M14 4c3-2 6-1 6-1s1 3-1 6l-6 6-5-5z"/><circle cx="14" cy="9" r="1.5"/>', ["launch", "startup", "ship"]),
  D("phone", "Phone", "product", '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>', ["mobile", "ios", "android", "app"]),
  D("laptop", "Laptop", "product", '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>', ["desktop", "computer", "mac"]),
  D("monitor", "Monitor", "product", '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>', ["screen", "display", "web app"]),
  D("watch", "Watch", "product", '<circle cx="12" cy="12" r="6"/><path d="M9 3h6l1 3H8zM9 21h6l1-3H8zM12 9v3l2 1"/>', ["wearable", "time"]),
  D("layout", "Layout", "product", '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>', ["dashboard", "ui", "page"]),
  D("bolt", "Bolt", "product", '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>', ["fast", "energy", "power", "speed"]),
  D("bell", "Bell", "product", '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>', ["notification", "alert"]),
  D("mail", "Mail", "product", '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>', ["email", "inbox", "message"]),
  D("chat", "Chat", "product", '<path d="M4 5h16v10H9l-5 4z"/>', ["message", "bubble", "support"]),
  D("cart", "Cart", "product", '<circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/><path d="M2 3h3l3 12h11l2-8H6"/>', ["shop", "ecommerce", "store"]),
  D("tag", "Tag", "product", '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7" cy="8" r="1"/>', ["label", "price", "sku"]),
  D("map", "Map", "product", '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>', ["location", "geo", "travel"]),
  D("pin", "Pin", "product", '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>', ["location", "marker", "place"]),
  // ── business ───────────────────────────────────────────────────────────
  D("briefcase", "Briefcase", "business", '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 12h18"/>', ["work", "client", "company", "job"]),
  D("building", "Building", "business", '<rect x="5" y="3" width="14" height="18"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3"/>', ["office", "company", "corporate", "internal"]),
  D("bank", "Bank", "business", '<path d="M3 9l9-5 9 5H3zM5 9v8M9 9v8M15 9v8M19 9v8M3 21h18"/>', ["finance", "institution"]),
  D("card", "Card", "business", '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>', ["payment", "credit", "billing", "stripe"]),
  D("coins", "Coins", "business", '<circle cx="9" cy="9" r="6"/><path d="M14 8a6 6 0 1 1-6 8"/>', ["money", "finance", "revenue"]),
  D("receipt", "Receipt", "business", '<path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21z"/><path d="M9 8h6M9 12h6"/>', ["invoice", "bill"]),
  D("users", "Users", "business", '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15 20a5 5 0 0 1 6-4.5"/>', ["team", "people", "clients", "crm"]),
  D("user", "User", "business", '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', ["person", "personal", "profile", "me"]),
  D("handshake", "Handshake", "business", '<path d="M3 10l4-4h4l3 3 3-3h4l-4 4-6 6-4-4"/><path d="M11 9l-3 3 2 2 3-3"/>', ["deal", "partner", "agreement"]),
  D("calendar", "Calendar", "business", '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>', ["schedule", "date", "event"]),
  D("clock", "Clock", "business", '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', ["time", "history", "schedule"]),
  D("flag", "Flag", "business", '<path d="M5 21V4h11l-2 4 2 4H5"/>', ["milestone", "goal", "marker"]),
  D("target", "Target", "business", '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>', ["goal", "aim", "focus", "okr"]),
  D("trophy", "Trophy", "business", '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 21h8M10 17h4v4"/>', ["award", "win", "prize"]),
  // ── creative ───────────────────────────────────────────────────────────
  D("pen", "Pen", "creative", '<path d="M4 20l4-1 10-10-3-3L5 16z"/><path d="M13 6l3 3"/>', ["edit", "write", "brand", "design"]),
  D("brush", "Brush", "creative", '<path d="M18 3l3 3-9 9-3-3z"/><path d="M9 12l3 3-2 2a3 3 0 0 1-4 0c-1-1-3 0-3 0s1-2 0-3a3 3 0 0 1 0-4z"/>', ["paint", "art", "design"]),
  D("palette", "Palette", "creative", '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="10" r="1"/><path d="M12 21c-1-3 1-4 3-4 3 0 4-2 4-3"/>', ["color", "art", "theme", "brand"]),
  D("camera", "Camera", "creative", '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3"/>', ["photo", "image", "picture"]),
  D("image", "Image", "creative", '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>', ["photo", "gallery", "media"]),
  D("film", "Film", "creative", '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>', ["video", "movie", "media"]),
  D("music", "Music", "creative", '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>', ["audio", "sound", "song"]),
  D("mic", "Mic", "creative", '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>', ["voice", "podcast", "audio", "speech"]),
  D("type", "Type", "creative", '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>', ["font", "text", "typography", "writing"]),
  D("book", "Book", "creative", '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z"/>', ["docs", "read", "library", "notes"]),
  D("sparkles", "Sparkles", "creative", '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M5 18l.7 2 2 .7-2 .7L5 23l-.7-1.6-2-.7 2-.7zM19 3l.5 1.5 1.5.5-1.5.5L19 7l-.5-1.5L17 5l1.5-.5z"/>', ["magic", "ai", "generate", "new"]),
  D("wand", "Wand", "creative", '<path d="M4 20l11-11M15 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 12l.5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5z"/>', ["magic", "ai", "generate"]),
  // ── science ────────────────────────────────────────────────────────────
  D("flask", "Flask", "science", '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>', ["lab", "experiment", "chemistry", "playground"]),
  D("atom", "Atom", "science", '<circle cx="12" cy="12" r="1.5"/><ellipse cx="12" cy="12" rx="9" ry="3.5"/><ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(120 12 12)"/>', ["physics", "science", "react"]),
  D("dna", "DNA", "science", '<path d="M6 3c0 6 12 6 12 12M18 3c0 6-12 6-12 12M6 21c0-2 1-3 2-4M18 21c0-2-1-3-2-4M8 7h8M8 17h8"/>', ["bio", "genetics", "helix"]),
  D("microscope", "Microscope", "science", '<path d="M9 3l5 5-4 4-5-5zM10 12l-2 2 2 2M6 21h12M9 21a6 6 0 0 1 6-9"/>', ["research", "lab", "analysis"]),
  D("telescope", "Telescope", "science", '<path d="M4 12l12-7 2 4-12 7zM12 14l4 7M12 14l-4 7M18 5l2-1 1 2-2 1"/>', ["astronomy", "research", "explore"]),
  D("planet", "Planet", "science", '<circle cx="12" cy="12" r="6"/><path d="M4 8c-2 3 8 11 16 8M20 8c2-3-8-11-16-8" opacity=".9"/>', ["space", "orbit", "saturn"]),
  D("leaf", "Leaf", "science", '<path d="M4 20c0-9 5-14 16-16-1 11-6 16-16 16z"/><path d="M4 20l8-8"/>', ["nature", "eco", "green", "plant"]),
  D("sun", "Sun", "science", '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', ["light", "day", "solar", "weather"]),
  D("moon", "Moon", "science", '<path d="M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z"/>', ["night", "dark", "sleep"]),
  D("mountain", "Mountain", "science", '<path d="M3 20l6-10 4 6 2-3 6 7z"/><path d="M9 10l2-4 2 3"/>', ["peak", "hike", "outdoor"]),
  // ── life ───────────────────────────────────────────────────────────────
  D("house", "House", "life", '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>', ["home", "personal", "family"]),
  D("heart", "Heart", "life", '<path d="M12 21s-8-5-8-11a4 4 0 0 1 8-2 4 4 0 0 1 8 2c0 6-8 11-8 11z"/>', ["love", "favorite", "health", "personal"]),
  D("coffee", "Coffee", "life", '<path d="M4 8h12v6a5 5 0 0 1-10 0zM16 9h2a2 2 0 0 1 0 4h-2M5 20h10"/>', ["cafe", "drink", "morning"]),
  D("plane", "Plane", "life", '<path d="M2 12l20-8-6 18-3-7z"/>', ["travel", "flight", "trip"]),
  D("car", "Car", "life", '<path d="M4 15l2-6h12l2 6v4h-2a2 2 0 0 1-4 0h-4a2 2 0 0 1-4 0H4z"/><path d="M4 15h16"/>', ["auto", "vehicle", "drive"]),
  D("bike", "Bike", "life", '<circle cx="6" cy="17" r="3.5"/><circle cx="18" cy="17" r="3.5"/><path d="M6 17l4-8h5l3 8M10 9h6l-4 8"/>', ["cycle", "sport", "fitness"]),
  D("dumbbell", "Dumbbell", "life", '<path d="M4 10v4M7 8v8M17 8v8M20 10v4M7 12h10"/>', ["gym", "fitness", "workout", "health"]),
  D("ring", "Ring", "life", '<circle cx="12" cy="13" r="6"/><path d="M9 4h6l2 3H7z"/>', ["jewelry", "bracelet", "wedding", "gem"]),
  D("gem", "Gem", "life", '<path d="M6 3h12l4 6-10 12L2 9z"/><path d="M2 9h20M10 3l2 6 2-6M6 9l6 12 6-12"/>', ["diamond", "jewel", "luxury", "bracelet"]),
  D("gift", "Gift", "life", '<rect x="3" y="9" width="18" height="12" rx="1.5"/><path d="M3 13h18M12 9v12M12 9a3 3 0 1 1 3-3c0 2-3 3-3 3zM12 9a3 3 0 1 0-3-3c0 2 3 3 3 3z"/>', ["present", "surprise", "reward"]),
  D("shirt", "Shirt", "life", '<path d="M8 3l4 2 4-2 5 4-3 3-2-1v12H8V9L6 10 3 7z"/>', ["clothes", "fashion", "merch"]),
  D("utensils", "Utensils", "life", '<path d="M7 3v18M5 3v5a2 2 0 0 0 4 0V3M17 3c-2 0-3 3-3 6v2h3v10"/>', ["food", "restaurant", "recipe"]),
  // ── fun ────────────────────────────────────────────────────────────────
  D("gamepad", "Gamepad", "fun", '<path d="M6 8h12a4 4 0 0 1 4 4v2a4 4 0 0 1-7 2.6L14 16h-4l-1 .6A4 4 0 0 1 2 14v-2a4 4 0 0 1 4-4z"/><path d="M7 11v3M5.5 12.5h3M16 12h.01M18 13h.01"/>', ["game", "play", "controller"]),
  D("dice", "Dice", "fun", '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01"/>', ["random", "chance", "game"]),
  D("ghost", "Ghost", "fun", '<path d="M5 21V11a7 7 0 0 1 14 0v10l-2.5-2-2.5 2-2-2-2 2-2.5-2z"/><circle cx="9.5" cy="11" r="1"/><circle cx="14.5" cy="11" r="1"/>', ["spooky", "boo", "hidden"]),
  D("skull", "Skull", "fun", '<path d="M12 3a8 8 0 0 0-5 14v3h10v-3a8 8 0 0 0-5-14z"/><circle cx="9" cy="11" r="1.5"/><circle cx="15" cy="11" r="1.5"/><path d="M10 17v3M14 17v3"/>', ["danger", "hack", "pirate", "abliterated"]),
  D("alien", "Alien", "fun", '<path d="M12 3c-5 0-8 4-8 8 0 5 5 10 8 10s8-5 8-10c0-4-3-8-8-8z"/><path d="M8 11c1 0 2 1 2 2M16 11c-1 0-2 1-2 2"/>', ["ufo", "space", "weird"]),
  D("cat", "Cat", "fun", '<path d="M5 4l3 4h8l3-4v9a7 7 0 0 1-14 0z"/><path d="M9 12h.01M15 12h.01M10 16c1 1 3 1 4 0"/>', ["pet", "kitty", "animal"]),
  D("dog", "Dog", "fun", '<path d="M7 5l2 3h6l2-3 3 3-2 3v5a5 5 0 0 1-10 0v-5L6 8z"/><path d="M10 12h.01M14 12h.01M12 15v2"/>', ["pet", "puppy", "animal"]),
  D("smile", "Smile", "fun", '<circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8 14c1.5 2 6.5 2 8 0"/>', ["happy", "face", "emoji"]),
  D("star", "Star", "fun", '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>', ["favorite", "rating", "top"]),
  D("crown", "Crown", "fun", '<path d="M3 18h18l1-11-5 4-5-7-5 7-5-4z"/><path d="M3 21h18"/>', ["king", "premium", "vip"]),
  D("flame", "Flame", "fun", '<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4-1-6 1-9z"/>', ["fire", "hot", "trending"]),
  D("zap-circle", "Spark", "fun", '<circle cx="12" cy="12" r="9"/><path d="M13 7l-4 6h4l-1 4 4-6h-4z"/>', ["spark", "energy", "codara"]),
  D("umbrella", "Umbrella", "fun", '<path d="M3 13a9 9 0 0 1 18 0zM12 13v6a2 2 0 0 1-4 0"/>', ["rain", "cover", "insurance"]),
  D("balloon", "Balloon", "fun", '<path d="M12 3a6 7 0 1 0 0 14 6 7 0 0 0 0-14z"/><path d="M12 17l-1 2h2zM12 19c0 1-1 2 0 3"/>', ["party", "celebrate", "float"]),
  // ── shapes ─────────────────────────────────────────────────────────────
  D("circle", "Circle", "shapes", '<circle cx="12" cy="12" r="9"/>', ["dot", "round"]),
  D("square", "Square", "shapes", '<rect x="4" y="4" width="16" height="16" rx="3"/>', ["box", "block"]),
  D("triangle", "Triangle", "shapes", '<path d="M12 3l10 18H2z"/>', ["delta", "warning"]),
  D("hexagon", "Hexagon", "shapes", '<path d="M12 2l9 5v10l-9 5-9-5V7z"/>', ["hex", "cell", "node"]),
  D("diamond", "Diamond", "shapes", '<path d="M12 3l9 9-9 9-9-9z"/>', ["rhombus", "gem"]),
  D("pentagon", "Pentagon", "shapes", '<path d="M12 3l9 6.5-3.5 10.5h-11L3 9.5z"/>', ["polygon"]),
  D("octagon", "Octagon", "shapes", '<path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/>', ["stop", "polygon"]),
  D("plus", "Plus", "shapes", '<path d="M12 5v14M5 12h14"/>', ["add", "cross", "health"]),
  D("asterisk", "Asterisk", "shapes", '<path d="M12 4v16M5 8l14 8M19 8L5 16"/>', ["star", "snow", "wildcard"]),
  D("infinity", "Infinity", "shapes", '<path d="M8 8c-3 0-5 2-5 4s2 4 5 4c4 0 4-8 8-8 3 0 5 2 5 4s-2 4-5 4c-4 0-4-8-8-8z"/>', ["loop", "forever", "endless"]),
  D("grid", "Grid", "shapes", '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>', ["apps", "tiles", "dashboard"]),
  D("waves", "Waves", "shapes", '<path d="M3 8c3-3 6 3 9 0s6 3 9 0M3 13c3-3 6 3 9 0s6 3 9 0M3 18c3-3 6 3 9 0s6 3 9 0"/>', ["water", "ocean", "flow"]),
];

const ICON_BY_ID: ReadonlyMap<string, WorkspaceIconDef> = new Map(
  WORKSPACE_ICONS.map((icon) => [icon.id, icon]),
);

export function resolveWorkspaceIcon(id: string | undefined | null): WorkspaceIconDef {
  return (id && ICON_BY_ID.get(id)) || (ICON_BY_ID.get(DEFAULT_WORKSPACE_ICON) as WorkspaceIconDef);
}

export function searchWorkspaceIcons(
  query: string,
  category: WorkspaceIconCategory | "all" = "all",
): WorkspaceIconDef[] {
  const q = query.trim().toLowerCase();
  return WORKSPACE_ICONS.filter((icon) => {
    if (category !== "all" && icon.category !== category) return false;
    if (!q) return true;
    return (
      icon.id.includes(q) ||
      icon.label.toLowerCase().includes(q) ||
      icon.keywords.some((keyword) => keyword.includes(q))
    );
  });
}

// One glyph, any size. `stroke-width` scales down slightly for large renders
// (the switch HUD) so the outline stays hairline-thin instead of chunky.
export function WorkspaceIconGlyph({
  icon,
  size = 14,
  strokeWidth,
  style,
  className,
}: {
  icon: string | undefined | null;
  size?: number;
  strokeWidth?: number;
  style?: React.CSSProperties;
  className?: string;
}) {
  const def = resolveWorkspaceIcon(icon);
  const width = strokeWidth ?? (size >= 40 ? 1.4 : 1.8);
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flex: "none", display: "block", ...style }}
      // Paths are static app-authored markup (see WORKSPACE_ICONS), never
      // user input, so inlining them is safe.
      dangerouslySetInnerHTML={{ __html: def.path }}
    />
  );
}
