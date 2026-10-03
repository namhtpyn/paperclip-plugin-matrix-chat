/**
 * Core types for the Paperclip plugin worker-side SDK.
 *
 * These types define the stable public API surface that plugin workers import
 * from `@paperclipai/plugin-sdk`.  The host provides a concrete implementation
 * of `PluginContext` to the plugin at initialisation time.
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 * @see PLUGIN_SPEC.md §29.2 — SDK Versioning
 */
/** A shared no-op span. It satisfies the span contract and does nothing, so a
 * plugin with no injected tracer changes no behavior. */
export const NOOP_PLUGIN_SPAN = {
    setAttribute() { },
    setStatus() { },
    end() { },
};
/** The default tracer. It opens no real span, so a lifecycle hook that wraps
 * work in a span behaves exactly as before when no live tracer is injected. */
export const NOOP_PLUGIN_TRACER = {
    startSpan: () => NOOP_PLUGIN_SPAN,
};
//# sourceMappingURL=types.js.map