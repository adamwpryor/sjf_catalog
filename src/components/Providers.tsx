'use client';

import React from "react";

/**
 * Renders the Providers component for wrapping application children.
 *
 * @param {Object} props - The component props.
 * @param {React.ReactNode} props.children - The child components.
 * @returns {JSX.Element} The rendered Providers component.
 */
export default function Providers({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
