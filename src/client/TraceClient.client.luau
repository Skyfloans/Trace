local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Trace = ReplicatedStorage.Trace
local Client = require(Trace.Client.Main)

Client.Start()
