import test from "node:test";
import assert from "node:assert/strict";
import { containsTerm, excludeReason, fundReason, normalizeName, reasonKind, vehicleNameReason } from "../src/filters.js";

test("SPV and vehicle name patterns", () => {
  for (const name of [
    "Acme Robotics SPV I LLC", "Sample Growth Fund II, LP", "Widget Ventures, a series of Master Platform LLC", "Platform Holdings Series LLC",
    "Example Holdings II, LLC", "Example Holdings 3 LLC", "Sample Co-Invest LLC", "Example Coinvest Partners", "Sample Feeder LP", "Example Partners Fund III", "Deal Syndicate 7 LLC",
  ]) assert.ok(vehicleNameReason(name), name);
});

test("operating-company names are not flagged", () => {
  for (const name of ["Example Widgets, Inc.", "Fundamental Robotics Corp.", "Holdings Technologies Inc.", "Example Holdings International Inc", "Seriesly Inc", "Spvantage Labs Inc", "Foundation Systems LLC"]) {
    assert.equal(vehicleNameReason(name), null, name);
  }
});

test("fund reason uses industry group, then fund type, then name", () => {
  assert.match(fundReason({ name: "Zed LP", industry_group: "Pooled Investment Fund" }), /^fund: industry group/);
  assert.match(fundReason({ name: "Zed LP", industry_group: "Investing" }), /^fund: industry group/);
  assert.match(fundReason({ name: "Zed", industry_group: "Other", investment_fund_type: "Hedge Fund" }), /^fund: investment fund type/);
  assert.match(fundReason({ name: "Zed SPV", industry_group: "Other Technology" }), /^vehicle-name/);
  assert.equal(fundReason({ name: "Example Widgets, Inc.", industry_group: "Other Technology" }), null);
});

test("user exclusions: whole-word terms and company names, case-insensitive", () => {
  assert.equal(containsTerm("Business Systems", "bus"), false);
  assert.equal(containsTerm("City Bus Co", "bus"), true);
  assert.match(excludeReason("Acme Delivery Robots, Inc.", { terms: ["delivery"] }), /^excluded: term "delivery"/);
  assert.match(excludeReason("ACME Corp", { companies: ["Acme, Inc."] }), /^excluded: company "Acme, Inc."/);
  assert.equal(excludeReason("Acmeville Labs", { companies: ["Acme"] }), null);
  assert.equal(excludeReason("Anything", {}), null);
  assert.equal(excludeReason("Anything", undefined), null);
  assert.equal(normalizeName("Acme & Sons, L.L.C."), "acme and sons");
});

test("reasonKind separates user exclusions from vehicle heuristics", () => {
  assert.equal(reasonKind('excluded: term "x"'), "excluded");
  assert.equal(reasonKind("fund: industry group"), "vehicle");
  assert.equal(reasonKind(null), null);
});
