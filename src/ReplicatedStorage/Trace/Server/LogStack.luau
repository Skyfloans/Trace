-- Kept as a server-side compatibility path. The collector is shared so the
-- client and server parse Roblox warning stacks identically.
return require(script.Parent.Parent.Shared.LogCollector)
