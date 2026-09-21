import { Button } from "@loopkit/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@loopkit/ui/components/dropdown-menu";
import { Skeleton } from "@loopkit/ui/components/skeleton";
import { cn } from "@loopkit/ui/lib/utils";
import { Link, useNavigate } from "@tanstack/react-router";
import { LogInIcon } from "lucide-react";

import { authClient } from "@/lib/auth-client";

/** `compact` renders an initial-only button, used by the collapsed sidebar rail. */
export default function UserMenu({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <Skeleton className={compact ? "size-7 rounded-md" : "h-9 w-24"} />;
  }

  if (!session) {
    return (
      <Link to="/login" aria-label={compact ? "Sign in" : undefined}>
        <Button
          variant="outline"
          size={compact ? "icon-sm" : "default"}
          className={compact ? "rounded-md" : undefined}
        >
          {compact ? <LogInIcon className="size-3.5" aria-hidden="true" /> : "Sign In"}
        </Button>
      </Link>
    );
  }

  const name = session.user.name || session.user.email;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size={compact ? "icon-sm" : "default"}
            className={cn(compact && "rounded-md")}
            aria-label={compact ? `Account: ${name}` : undefined}
          />
        }
      >
        {compact ? (
          <span className="text-[11px] font-semibold uppercase">{name.slice(0, 1)}</span>
        ) : (
          name
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="bg-card">
        <DropdownMenuGroup>
          <DropdownMenuLabel>My Account</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem>{session.user.email}</DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              authClient.signOut({
                fetchOptions: {
                  onSuccess: () => {
                    navigate({
                      to: "/",
                    });
                  },
                },
              });
            }}
          >
            Sign Out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
