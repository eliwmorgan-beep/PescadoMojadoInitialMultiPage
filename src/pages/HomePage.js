import React from "react";
import { NavLink } from "react-router-dom";
import Header from "../components/Header";

export default function HomePage() {
  const COLORS = {
    blueLight: "#e6f3ff",
    navy: "#1b1f5a",
    orange: "#f4a83a",
    panel: "#ffffff",
    border: "#dbe9ff",
  };

  const buttonStyle = {
    padding: "14px 18px",
    borderRadius: 14,
    border: `2px solid ${COLORS.navy}`,
    fontWeight: 900,
    cursor: "pointer",
    textDecoration: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 160,
    background: COLORS.orange,
    color: "#1a1a1a",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: `linear-gradient(180deg, ${COLORS.blueLight} 0%, #ffffff 60%)`,
        display: "flex",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 760 }}>
        <Header />

        {/* Button panel */}
        <div
          style={{
            marginTop: 18,
            background: COLORS.panel,
            borderRadius: 18,
            padding: 22,
            border: `2px solid ${COLORS.navy}`,
            boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 420,
              display: "flex",
              gap: 14,
              justifyContent: "center",
              flexWrap: "wrap",
            }}
          >
            <NavLink to="/tags" style={buttonStyle}>
              Tags
            </NavLink>

            <NavLink to="/putting" style={buttonStyle}>
              Putting
            </NavLink>
          </div>
        </div>
      </div>
    </div>
  );
}
