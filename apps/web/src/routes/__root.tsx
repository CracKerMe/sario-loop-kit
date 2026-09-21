import { Toaster } from "@loopkit/ui/components/sonner";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { evlogErrorHandler } from "evlog/nitro/v3";
import { ThemeProvider } from "next-themes";

import appCss from "../index.css?url";

export interface RouterAppContext {}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  server: {
    middleware: [createMiddleware().server(evlogErrorHandler)],
  },

  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Sario Loop Kit — Lifecycle marketing engine",
      },
      {
        name: "description",
        content:
          "Self-hostable lifecycle marketing: visual journey builder compiled onto a durable workflow engine.",
      },
      {
        name: "theme-color",
        media: "(prefers-color-scheme: light)",
        content: "#f7f6f3",
      },
      {
        name: "theme-color",
        media: "(prefers-color-scheme: dark)",
        content: "#12131a",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      {
        rel: "preconnect",
        href: "https://fonts.googleapis.com",
      },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
      },
      {
        rel: "icon",
        type: "image/svg+xml",
        href: `data:image/svg+xml,${encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b7cf8"/><stop offset="1" stop-color="#5b5bd6"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><path d="M21.5 10.5a7.8 7.8 0 1 0 2 5.2" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><circle cx="23.5" cy="15.7" r="2" fill="#fff"/></svg>`,
        )}`,
      },
    ],
  }),

  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <Outlet />
          <Toaster richColors />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
