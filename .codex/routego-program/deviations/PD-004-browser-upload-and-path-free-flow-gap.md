# PD-004：Browser upload and path-free flow gap

- Status: accepted; corrective change dispatching
- Affected changes: `add-routego-image-creation`, `add-routego-image-library`, `add-routego-studio`
- Corrective change: `complete-routego-browser-boundaries`
- Confirmed independently by: Studio and Creation startup audits
- Reported before: affected proposal/design/spec/task freeze or product implementation

## Finding

The frozen public image operations intentionally use server-local paths, while Studio must operate only with browser-safe stable identifiers. The current local service contracts do not model the complete reverse resource flow from browser uploads or Library assets into Creation execution, and do not provide path-free results for browser display.

Confirmed gaps include:

- no session upload reservation/completion lifecycle for image, mask, or ZIP bytes;
- no path-free Studio generate/edit/batch inputs, results, partial events, or SSE projections;
- no path-free Studio Library search result with protected thumbnails/resources;
- no settings mutation for defaults and output-directory selection/clear semantics;
- public search results and image results still contain local paths unsuitable for browser boundaries;
- the deterministic mock returns an empty public gallery and cannot drive the approved Studio upload, gallery, compare, batch, trash, favorite, retry, or edit journeys.

## Decision

Dispatch a new Foundation-owned Browser Boundary change. Do not authorize Studio, Creation, or Library to duplicate shared schemas or resolve another lane's filesystem paths.

The corrective design SHALL preserve the seven public MCP operations and add Studio-only local service operations that use `assetId`, `artifactId`, `uploadResourceId`, and session-protected relative resource URLs. Binary bytes remain on protected HTTP upload/resource routes and never enter JSON contracts or logs.

Integration owns composition of the upload/Library resource resolver and Creation executor into one `LocalRoutegoService`. Creation validates and executes resolved internal requests but does not implement Library lookup. Library later implements storage/resource ownership but does not execute provider operations. Studio consumes only the path-free boundary.

## Required end-to-end contract matrix

- text-only generate;
- reference upload to generate;
- Library asset or upload target edit with supporting images and mask bound to target slot 0;
- mixed batch with ordered partial results;
- partial/SSE results with `receivedAnyOutput` and `mayHaveBilled` preserved;
- path-free Library search, thumbnail, detail, source/result comparison, retry/edit handoff;
- ZIP upload/import and protected ZIP export resource;
- settings defaults and output-directory update/clear;
- capability-unavailable UI flow without fabricated success.

## Required verification

- strict OpenSpec validation and explicit public-operation freeze tests;
- browser-safe source/declaration/emitted-output audit with no Node built-ins or local paths in Studio DTOs;
- deterministic non-empty mock gallery and upload/path-free operation tests;
- upload MIME/size/expiry/session/origin and unsafe path/URL rejection tests;
- safety, typecheck, build, all tests, package exports, diff scope, and Git cleanliness;
- no root dependency/lockfile or product implementation changes.
