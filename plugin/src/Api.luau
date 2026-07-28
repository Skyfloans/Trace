--!strict

local HttpService = game:GetService("HttpService")

export type StudioContext = {
	installId: string,
	robloxUserId: string,
	studioPlaceId: string,
	studioUniverseId: string,
}

export type PairingRequest = {
	browserUrl: string,
	clientProof: string,
	expiresAt: string,
	requestId: string,
}

export type PluginSession = {
	credentialId: string,
	expiresAt: string,
	project: {
		iconUrl: string?,
		id: string,
		name: string,
		robloxUniverseId: string,
	},
	studioPlaceId: string,
	targetUniverseId: string,
}

export type VerifiedSession = PluginSession & {
	token: string,
}

type ApiErrorBody = {
	error: {
		code: string?,
		message: string?,
	}?,
}

type ApiResponse<T> = {
	data: T?,
	errorCode: string?,
	errorMessage: string?,
	ok: boolean,
	statusCode: number?,
}

local Api = {}
Api.__index = Api

export type Client = typeof(setmetatable(
	{} :: {
		baseUrl: string,
	},
	Api
))

function Api.new(baseUrl: string): Client
	return setmetatable({
		baseUrl = string.gsub(baseUrl, "/$", ""),
	}, Api)
end

function Api._request<T>(self: Client, method: string, path: string, body: any?, token: string?): ApiResponse<T>
	local headers: { [string]: string } = {
		["accept"] = "application/json",
	}
	if body then headers["content-type"] = "application/json" end
	if token then headers["authorization"] = "Bearer " .. token end

	local requestOptions: { [string]: any } = {
		Url = self.baseUrl .. path,
		Method = method,
		Headers = headers,
		Timeout = 15,
	}
	if body then requestOptions.Body = HttpService:JSONEncode(body) end

	local callSucceeded, responseOrError = pcall(function() return HttpService:RequestAsync(requestOptions) end)
	if not callSucceeded then
		return {
			ok = false,
			errorCode = "network_error",
			errorMessage = "Studio could not reach Trace. Check the plugin's HTTP permission and try again.",
		}
	end

	local response = responseOrError :: {
		Body: string,
		StatusCode: number,
		StatusMessage: string,
		Success: boolean,
	}
	local decoded: any = nil
	if response.Body ~= "" then
		local decodedSuccessfully, value = pcall(function() return HttpService:JSONDecode(response.Body) end)
		if decodedSuccessfully then decoded = value end
	end

	if not response.Success then
		local errorBody = decoded :: ApiErrorBody?
		return {
			ok = false,
			statusCode = response.StatusCode,
			errorCode = if errorBody and errorBody.error then errorBody.error.code else "request_failed",
			errorMessage = if errorBody
					and errorBody.error
					and errorBody.error.message
				then errorBody.error.message
				else string.format("Trace returned %d %s.", response.StatusCode, response.StatusMessage),
		}
	end

	return {
		ok = true,
		statusCode = response.StatusCode,
		data = decoded :: T,
	}
end

function Api.startPairing(self: Client, context: StudioContext): ApiResponse<PairingRequest>
	return self:_request("POST", "/v1/plugin-auth/requests", context, nil)
end

function Api.verifyPairing(
	self: Client,
	requestId: string,
	clientProof: string,
	code: string
): ApiResponse<VerifiedSession>
	return self:_request("POST", "/v1/plugin-auth/requests/" .. HttpService:UrlEncode(requestId) .. "/verify", {
		clientProof = clientProof,
		code = code,
	}, nil)
end

function Api.getSession(self: Client, token: string): ApiResponse<PluginSession>
	return self:_request("GET", "/v1/plugin-auth/session", nil, token)
end

function Api.revoke(self: Client, token: string): ApiResponse<any>
	return self:_request("POST", "/v1/plugin-auth/revoke", nil, token)
end

return Api
