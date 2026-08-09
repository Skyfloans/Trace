local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Trace = ReplicatedStorage.Trace
local Server = require(Trace.Server.Main)

Server.Start()
