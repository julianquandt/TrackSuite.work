import { defineConfig } from "vite";

export default defineConfig({
    clearScreen: false,
    server: {
        port: 5173,
        strictPort: true,
        // Allow importing ../shared (code shared with the web app).
        fs: { allow: [".."] },
        watch: {
            ignored: ["**/src-tauri/**"],
        },
    },
});