import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { LaptopIcon, MoonIcon, SunIcon } from "lucide-react";

import { Button } from "@loopkit/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@loopkit/ui/components/dropdown-menu";
import { cn } from "@loopkit/ui/lib/utils";

const THEME_OPTIONS = [
  { id: "light", label: "Light", icon: SunIcon },
  { id: "dark", label: "Dark", icon: MoonIcon },
  { id: "system", label: "System", icon: LaptopIcon },
] as const;

type ThemeId = (typeof THEME_OPTIONS)[number]["id"];

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const active = (mounted ? theme : "system") as ThemeId;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label="Toggle theme" />}
      >
        {!mounted || resolvedTheme === "dark" ? (
          <MoonIcon className="size-4" />
        ) : (
          <SunIcon className="size-4" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="bg-card">
        <DropdownMenuItem>Theme</DropdownMenuItem>
        <DropdownMenuSeparator />
        {THEME_OPTIONS.map(({ id, label, icon: Icon }) => (
          <DropdownMenuItem
            key={id}
            onClick={() => setTheme(id)}
            className={cn("justify-between", active === id && "font-medium text-foreground")}
          >
            <span className="flex items-center gap-2">
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </span>
            {active === id && (
              <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
