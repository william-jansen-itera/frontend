"use client";
import { useAuth } from "../useAuth";

const MDSUSER_GROUP_ID = "359aee47-edae-40f7-9842-7de4cbf77263";

export default function About() {
  const { user, signIn } = useAuth();

  // Check if user is authenticated and in the group
  const isInGroup = user?.groups?.includes(MDSUSER_GROUP_ID);

  if (!user) {
    return (
      <div>
        <h1>About Page</h1>
        <p>You must sign in to view this page.</p>
        <button onClick={signIn}>Sign In</button>
      </div>
    );
  }

  if (!isInGroup) {
    return (
      <div>
        <h1>About Page</h1>
        <p>You do not have permission to view this page.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>About Page</h1>
      <p>This is a new page in your Next.js Static Web App.</p>
    </div>
  );
}
