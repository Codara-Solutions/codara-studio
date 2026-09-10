// The chat model catalogue moved to @shared so the main process can project
// the very same picker to a paired phone (`cora.models`). Every renderer
// import keeps working through this re-export.
export * from "@shared/chat-models";
