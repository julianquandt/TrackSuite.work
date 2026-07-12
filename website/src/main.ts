import "./styles.css";
import { route, startRouter } from "./router";
import { renderNav } from "./nav";
import { renderLanding } from "./pages/landing";
import { renderRegister } from "./pages/register";
import { renderLogin } from "./pages/login";
import { renderDashboard } from "./pages/dashboard";
import { renderDocs } from "./pages/docs";
import { renderTracker } from "./pages/tracker";

const app = document.getElementById("app")!;

function render(page: (el: HTMLElement) => void): void {
    app.innerHTML = "";
    page(app);
    renderNav(app);
}

route("#/", () => render(renderLanding));
route("#/register", () => render(renderRegister));
route("#/login", () => render(renderLogin));
route("#/dashboard", () => render(renderDashboard));
route("#/docs", () => render(renderDocs));
route("#/tracker", () => render(renderTracker));

startRouter();

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js")
            .then(reg => console.log("Service Worker registered!", reg.scope))
            .catch(err => console.warn("Service Worker registration failed", err));
    });
}
