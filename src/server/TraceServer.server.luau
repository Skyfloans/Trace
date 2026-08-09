local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Trace = ReplicatedStorage:WaitForChild("Trace")
local Server = require(Trace.Server.Main)

Server.Start()
