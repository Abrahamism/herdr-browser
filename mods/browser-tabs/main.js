// Browser tabs: the tabs of the Chromium browser that herdr-browser controls.
//
// It reads the port herdr-browser saved in its profile state and asks the
// DevTools HTTP endpoint for the page list. Clicking a row activates that tab
// (`/json/activate/<id>`). No helper program, no credentials: only localhost.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, home, nextCommand, readTextFile, run, theme } from "herdr";

const DEFAULT_REFRESH_MS = 3000;
const CONFIG_NAME = "browser-tabs.json";

function configPath() {
  return `${appHome()}/mods/browser-tabs/${CONFIG_NAME}`;
}

async function readConfig() {
  try {
    const text = await readTextFile(configPath());
    if (!text) return { profile: "default", refreshMs: DEFAULT_REFRESH_MS };
    const parsed = JSON.parse(text);
    return {
      profile: typeof parsed.profile === "string" ? parsed.profile : "default",
      refreshMs: Number.isFinite(parsed.refreshMs) ? Math.max(1000, parsed.refreshMs) : DEFAULT_REFRESH_MS
    };
  } catch (_) {
    return { profile: "default", refreshMs: DEFAULT_REFRESH_MS };
  }
}

function statePaths(profile) {
  const h = home();
  return [
    `${h}/AppData/Local/herdr-browser/profiles/${profile}/state.json`,
    `${h}/Library/Application Support/herdr-browser/profiles/${profile}/state.json`,
    `${h}/.local/share/herdr-browser/profiles/${profile}/state.json`
  ];
}

async function readBrowser(profile) {
  for (const path of statePaths(profile)) {
    const text = await readTextFile(path);
    if (!text) continue;
    try {
      const state = JSON.parse(text);
      if (state && state.port) return state;
    } catch (_) {
      // A half-written state file: try the next candidate.
    }
  }
  return null;
}

function clock(date) {
  if (!date) return "—";
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export default class BrowserTabs extends View {
  init(_props, cx) {
    this.tabs = [];
    this.running = false;
    this.port = null;
    this.browser = null;
    this.error = null;
    this.updated = null;
    this.busy = false;
    this.refresh(cx);
    cx.timer.every(DEFAULT_REFRESH_MS, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.refresh(cx);
      }
    });
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const config = await readConfig();
        const state = await readBrowser(config.profile);
        if (!state) {
          this.running = false;
          this.tabs = [];
          this.port = null;
          this.browser = null;
          this.error = null;
        } else {
          const response = await fetch(`http://127.0.0.1:${state.port}/json/list`);
          if (!response.ok) throw new Error(`DevTools HTTP ${response.status}`);
          const list = await response.json();
          this.running = true;
          this.port = state.port;
          this.browser = state.browser ?? "browser";
          this.tabs = list
            .filter((target) => target.type === "page")
            .map((target, index) => ({
              id: target.id,
              index: index + 1,
              title: target.title || "(sin título)",
              url: target.url || ""
            }));
          this.error = null;
        }
      } catch (error) {
        this.error = String(error?.message ?? error);
      }
      this.updated = new Date();
      this.busy = false;
      cx.notify();
    });
  }

  activate(id) {
    if (!this.port) return;
    fetch(`http://127.0.0.1:${this.port}/json/activate/${id}`).catch(() => {
      // The tab may have closed between the poll and the click; the next poll fixes it.
    });
  }

  render() {
    const t = theme();
    const header = h_flex()
      .px(12)
      .py(8)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(div().text_size(12.5).text_color(t.foreground).child("Browser"))
      .child(div().flex_1())
      .child(
        div()
          .text_size(10.5)
          .text_color(t.dim)
          .child(this.running ? `${this.tabs.length} tabs` : "offline")
      )
      .child(
        div()
          .id("browser-tabs-refresh")
          .px(6)
          .py(2)
          .rounded(5)
          .text_size(12)
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("browser-tabs.refresh"))
          .child("↻")
      );

    let body;
    if (!this.running) {
      body = v_flex()
        .flex_1()
        .p(14)
        .gap(6)
        .child(div().text_size(12).text_color(t.muted).child("Browser not running"))
        .child(
          div()
            .text_size(10.5)
            .text_color(t.dim)
            .child("Start it with: herdr-browser open <url>")
        )
        .when(Boolean(this.error), (el) =>
          el.child(div().text_size(10).text_color(t.dim).child(this.error))
        );
    } else if (!this.tabs.length) {
      body = v_flex().flex_1().p(14).child(div().text_size(12).text_color(t.muted).child("No tabs"));
    } else {
      body = v_flex()
        .flex_1()
        .overflow_scroll()
        .children(
          this.tabs.map((tab) =>
            h_flex()
              .id(`browser-tab-${tab.id}`)
              .px(12)
              .py(7)
              .gap(8)
              .items_center()
              .border_b(1)
              .border_color(t.chrome)
              .hover((s) => s.bg(t.hover))
              .on_click(() => this.activate(tab.id))
              .child(div().w(18).flex_none().text_size(10.5).text_color(t.dim).child(String(tab.index)))
              .child(
                v_flex()
                  .flex_1()
                  .gap(1)
                  .child(div().text_size(12).text_color(t.foreground).truncate().child(tab.title))
                  .child(div().text_size(10).text_color(t.dim).truncate().child(tab.url))
              )
          )
        );
    }

    const footer = h_flex()
      .px(12)
      .py(6)
      .gap(6)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .child(
        div()
          .text_size(10)
          .text_color(t.dim)
          .child(this.running ? `${this.browser} · port ${this.port}` : "not running")
      )
      .child(div().flex_1())
      .child(div().text_size(10).text_color(t.dim).child(clock(this.updated)));

    return v_flex().size_full().bg(t.chrome).text_color(t.foreground).child(header).child(body).child(footer);
  }
}
