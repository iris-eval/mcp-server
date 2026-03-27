import { redirect } from "next/navigation";

export default function LearnIndex(): never {
  redirect("/learn/agent-eval");
}
