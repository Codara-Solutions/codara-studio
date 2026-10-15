// The names feature tips listen on, apart from the catalog so the keyboard
// dispatcher and any other always-loaded module can report a use without
// pulling the catalog into the main bundle.

/** Window event any code can dispatch with { id } to record a use. */
export const FEATURE_USED_EVENT = "codara:feature-used";
/** Window event the keyboard dispatcher sends with { id } after a command ran. */
export const COMMAND_RAN_EVENT = "codara:command-ran";
/** Attribute that makes an element a tip target and a click signal for an entry. */
export const FEATURE_TIP_ATTRIBUTE = "data-feature-tip";
