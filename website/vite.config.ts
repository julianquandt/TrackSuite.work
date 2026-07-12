import { defineConfig } from "vite";

export default defineConfig({
    root: ".",
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
    server: {
        port: 3000,
        proxy: {
            "/api": {
                target: "http://127.0.0.1:8007",
                rewrite: (path) => path.replace(/^\/api/, ""),
            },
        },
    },
});
