import { Loader2Icon } from "lucide-react";

export default function Loader() {
  return (
    <div
      className="flex h-full items-center justify-center pt-8"
      role="status"
      aria-label="Loading"
    >
      <Loader2Icon className="size-6 animate-spin text-primary" />
    </div>
  );
}
