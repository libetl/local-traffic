# Copilot Instructions for local-traffic

## description

  local-traffic is a tiny, dependency-free HTTP/2 (or HTTP/1.1) reverse proxy designed to run locally.
  It targets fast startup, minimal footprint, and simple installation. Configuration is via a JSON mapping file (.local-traffic.json)
  that routes URL paths to destinations (URLs, files, data URIs, etc.). The project is implemented in TypeScript, targets Node.js >=8,
  and strictly avoids transitive dependencies.

## goals

  - Keep the codebase minimal, maintainable, and easy to audit (single file, no dependencies).
  - Ensure proxy logic is robust, secure, and highly performant.
  - Support advanced mapping (regex, interpolation, special protocols).
  - Offer seamless local development for mapping, mocking, and proxying requests.

## main function

The main function is called serve. Its workflow is strictly chronological and follows a clear phase mechanism:
    1. Mapping phase: Determine the destination from the incoming request using .local-traffic.json.
    2. Connection phase: Establish the appropriate connection to the mapped destination (file, URL, worker, mock, etc.).
    3. Data sending phase: Forward the client request data to the destination.
    4. Data retrieval phase: Retrieve and return the response data to the client.

## best practices

  - The overwhelming majority of features must be implemented using functional programming style. Prefer the use of const, pure functions, and set-theoretic operations (such as map, filter, reduce, etc.) to create new values, rather than relying on imperative algorithms or mutable state. This applies in all cases where imperative vs. functional coding is a draw in terms of performance and clarity.
  - Prefer short exits (early returns) in code to avoid unnecessary nesting of code blocks. If a value is null or a precondition fails, exit the function immediately to keep the rest of the function clean and readable.
  - Never add any external or third-party dependencies; use only Node.js built-in modules.
  - The state variable must only be modified in one place: inside the update function.
  - The main serve function must execute in order, following the four phases: mapping → connection → data sending → retrieval.
  - All features (except mutually-exclusive execution modes) must be properly configured, altered, and gracefully terminated during the application lifecycle.
  - No feature (except an execution mode) should require a configuration change to be started; features must be initialized and ready at launch, and respond dynamically to config changes.
  - All navigation security features must be individually and fully disableable via the disableWebSecurity option, in order to offer the most flexible environment for developers.
  - The "mock" mode must bypass any connection to a remote machine: when mock mode is active, all remote network calls must be avoided. Mock mode must be able to run fully offline, even if the machine is disconnected from the network.
  - All "web" features must be interactive and support either WebSocket streaming or Server-Sent Events (SSE). Web features must detect if the program has been stopped, and must offer a silent, automatic resumption of activity on program restart.
  - Except in "monitoringDisplay" mode, only normalized logs using this.quickStatus and this.log are permitted, and they must follow a fixed width format. All other outputs including console.log, console.error, stdout.write, and stderr.write are strictly forbidden to keep the program neutral in verbosity, as desired by the user.
  - Each feature must have a dedicated reference emoji, to provide a mnemonic and visually identify the log source in all logs.
  - Ensure that the main mock mode features and configuration features are accessible and controllable through the local-traffic APIs.
  - Expose contracts (such as TypeScript types/interfaces) for configuration and mock mode as part of the public API, to make local-traffic programmable and orchestrable from the outside when the user configures their instance externally.
  - Always add a comment explaining any logic that appears illogical, counter-intuitive, or is present only to work around external constraints (for example: using await new Promise(resolve => setTimeout(resolve, 0)) to ensure the body is loaded before proceeding).
  - Absolutely do not restructure: The entire library must remain in a single file named index.ts. Do not export web pages as separate HTML or JSON files. Do not refactor the whole application. Always preserve the naive "all-in-one" aspect, even if it seems unsuitable.
  - Leave the code in index.ts with neither too much nor too little whitespace; above all, when a feature is expected, always prioritize the smallest possible bundle size.
  - On web pages, whenever a feature requires capabilities that Node.js lacks and which are particularly difficult to implement natively (such as json-schema validation or ace editor), prefer importing scripts from the jsDelivr CDN.
  - Write clean, well-typed TypeScript.
  - Prioritize security in all proxy features and mapping handlers, unless disableWebSecurity is explicitly set.
  - Avoid unnecessary abstractions; keep logic straightforward.
  - Use clear comments for any complex logic, especially around mapping and protocol handling.
  - Maintain compatibility with Node.js >=8.
  - Provide and maintain an automated crash-test mode that can be run on demand to validate the robustness of the server.
  - Export all critical utility functions (helpers) to ensure testability and ease of maintenance.
  - Generate detailed, user-friendly HTML error pages that include relevant context to facilitate debugging.
  - Ensure all embedded web pages (config, logs, mocks, etc.) deliver an interactive and ergonomic user experience, leveraging tools such as JSONEditor or WebSocket synchronization where appropriate.
  - Guarantee that configuration is always hot-reloaded dynamically, with any changes reflected live without requiring a server restart.

## features to focus

  - HTTP/2 and HTTP/1.1 proxying, with optional TLS.
  - Flexible mapping via .local-traffic.json (URL, file, data, config, logs, recorder, worker, mock, etc.).
  - Regex and string interpolation in mapping.
  - Mock mode operation that requires zero network connectivity.
  - Interactive web features (WebSocket/SSE), with resume-on-restart.
  - Configuration and mock features accessible and programmable from the API (public contracts/types/interfaces).
  - Minimal logging and worker support.
  - Fast cold start and tiny bundle size.
  - timeouts configuration
  - disableWebSecurity feature
  - performant config and log pages
  - http file serve
  - data url serve
  - recorder feature
  - json api modes on mock and config features
  - always-well-formatted logs in terminal
  - unit tests that don't require the network
  - crash-test mode

## examples of features to implement

  - "Add support for a new mapping protocol (e.g., 'worker://')."
  - "Improve the performance of HTTP/2 stream handling."
  - "Add a utility to validate .local-traffic.json mappings."
  - "Enhance logging for request lifecycle events."
  - "Refactor proxy logic for clarity and maintainability."
  - "Expose the configuration and mock mode contracts/types/interfaces for external control."
  - "Add crash-test mode for robustness testing."
  - "Write unit tests that do not require network connectivity."

## exclude

  - Do not add third-party dependencies or external modules. Use only Node.js built-ins.
  - Do not use features unavailable in Node.js >=8.
  - Do not bloat the bundle or add unrelated features.
  - Do not split code into multiple files or modules; keep everything in index.ts.
  - Do not export web resources (pages, assets) as separate files. Keep everything in the single file, even if this seems naive.
  - Do not add native GUI toolkits or desktop application frameworks (such as Electron, Qt, GTK, WPF, or JavaFX). All user interfaces must remain terminal-based or browser-based web UIs (HTML/CSS/JS/Bootstrap).
  - Do not add dynamic plugin loading, code evaluation, or runtime code execution features (such as eval, new Function, or require-from-string).
  - Do not implement analytics, telemetry, or any kind of usage tracking in mock mode. Any future telemetry or analytics features must be strictly limited to proxy mode and must be opt-in.
  - Do not persist any data or logs outside of the specified configuration or mapping files.
  - Do not add support for cloud-specific APIs or integrations (AWS, GCP, Azure, etc).
  - Do not implement automatic updates, self-modifying code, or code that changes itself at runtime.
  - Do not use global variables or assign/mutate any data on global, globalThis, or the global object. All state must be explicit and scoped.
  - Do not design features that only work via the CLI; all core functionality must be accessible programmatically as a library.
  - Do not expose or rely on undocumented or internal Node.js APIs.
  - Do not implement multi-threading, worker threads, or spawn child processes unless strictly required by Node.js core APIs.
  - Do not add support for running as a system service, Windows service, or background daemon. While local-traffic does not register itself as a service, users are free to adapt and run it in any environment (such as Docker, Kubernetes, Windows services, or via cron jobs) if desired.
