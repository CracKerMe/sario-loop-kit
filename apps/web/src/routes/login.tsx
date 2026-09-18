import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { Logo } from "@/components/logo";
import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";

export const Route = createFileRoute("/login")({
  component: RouteComponent,
});

function RouteComponent() {
  const [showSignIn, setShowSignIn] = useState(false);

  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden px-4 py-10">
      <Logo to="/" />
      <main
        key={showSignIn ? "in" : "up"}
        className="lk-fade-up mt-6 w-full max-w-sm rounded-2xl border border-border bg-card/90 p-6 shadow-xl backdrop-blur"
      >
        {showSignIn ? (
          <SignInForm onSwitchToSignUp={() => setShowSignIn(false)} />
        ) : (
          <SignUpForm onSwitchToSignIn={() => setShowSignIn(true)} />
        )}
      </main>
      <p className="mt-6 text-center text-xs text-muted-foreground">
        By continuing, you agree to create a workspace with a welcome email template.
      </p>
      <Link
        to="/dashboard"
        className="mt-2 text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
