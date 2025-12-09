import { defineConfig } from "vite";
import { resolve } from "path";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

export default defineConfig({
  server: {
    // Enable CORS for local development with different origins (e.g., localhost vs 192.168.x.x)
    cors: true,
    // Allow access from any host (needed for network IP access)
    host: true,
  },
  plugins: [
    cssInjectedByJsPlugin({
      injectCodeFunction: function injectCodeCustomRunTimeFunction(
        cssCode: string,
        options
      ) {
        try {
          if (typeof document != "undefined") {
            const elementStyle = document.createElement("style");
            // this attribute will allow the client application using this connector to
            // identify the style tag and remove it if needed for cleanup purposes
            elementStyle.setAttribute("data-ctc-connector-styles", "");
            for (const attribute in options.attributes) {
              elementStyle.setAttribute(
                attribute,
                options.attributes[attribute]
              );
            }
            elementStyle.appendChild(document.createTextNode(cssCode));
            document.head.appendChild(elementStyle);
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("vite-plugin-css-injected-by-js", e);
        }
      },
    }),
  ],
  build: {
    outDir: resolve(__dirname, "public"),
    lib: {
      // Could also be a dictionary or array of multiple entry points
      entry: resolve(__dirname, "src/main.ts"),
      name: "Connector",
      formats: ["es", "umd"],
      // the proper extensions will be added
      fileName: (format) => `connector-enabler.${format}.js`,
    },
  },
});
