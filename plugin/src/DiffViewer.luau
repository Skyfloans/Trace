--!strict

local Api = require(script.Parent.Api)
local ConfirmationModal = require(script.Parent.ConfirmationModal)
local Theme = require(script.Parent.Theme)

type Palette = Theme.Palette
type ProposalDetail = Api.ProposalDetail
type ProposalFile = Api.ProposalFile

export type Callbacks = {
	onAccept: (proposalId: string) -> (),
	onReject: (proposalId: string) -> (),
	onRetry: (proposalId: string) -> (),
}

local DiffViewer = {}
DiffViewer.__index = DiffViewer

local FONT = Enum.Font.Gotham
local FONT_MEDIUM = Enum.Font.GothamMedium
local MONO = Enum.Font.RobotoMono

local SPACE_1 = 4
local SPACE_2 = 8
local SPACE_3 = 12
local SPACE_4 = 16
local SPACE_8 = 32
local TOOLBAR_HEIGHT = 52
local FILE_RAIL_WIDE = 188
local FILE_RAIL_COMPACT = 156
local FILE_HEADER_HEIGHT = 44
local FILE_ROW_HEIGHT = 48
local ACTION_HEIGHT = 34
local CODE_HEADER_HEIGHT = 30
local CODE_ROW_HEIGHT = 20
local HUNK_ROW_HEIGHT = 26
local LINE_GUTTER_WIDTH = 46
local MIN_CODE_COLUMN_WIDTH = 320
local SPLIT_DIVIDER_WIDTH = 1

local function addCorner(parent: Instance, radius: number)
	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, radius)
	corner.Parent = parent
end

local function addStroke(parent: Instance, color: Color3)
	local stroke = Instance.new("UIStroke")
	stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	stroke.Color = color
	stroke.Thickness = 1
	stroke.Parent = parent
end

local function clear(parent: Instance)
	for _, child in parent:GetChildren() do
		child:Destroy()
	end
end

local function changeCounts(file: ProposalFile): (number, number)
	local additions = 0
	local deletions = 0
	for _, hunk in file.patch.hunks do
		for _, line in hunk.lines do
			local prefix = string.sub(line, 1, 1)
			if prefix == "+" then
				additions += 1
			elseif prefix == "-" then
				deletions += 1
			end
		end
	end
	return additions, deletions
end

local function createActionButton(
	parent: Instance,
	palette: Palette,
	text: string,
	kind: "primary" | "secondary" | "danger",
	width: number,
	order: number,
	onClick: () -> ()
)
	local button = Instance.new("TextButton")
	button.Name = text
	button.AutoButtonColor = false
	button.Font = FONT_MEDIUM
	button.LayoutOrder = order
	button.Size = UDim2.fromOffset(width, ACTION_HEIGHT)
	button.Text = text
	button.TextSize = 13
	if kind == "primary" then
		button.BackgroundColor3 = palette.accent
		button.TextColor3 = palette.accentInk
	elseif kind == "danger" then
		button.BackgroundColor3 = palette.error:Lerp(palette.main, 0.82)
		button.TextColor3 = palette.error
		addStroke(button, palette.error:Lerp(palette.main, 0.5))
	else
		button.BackgroundColor3 = palette.button
		button.TextColor3 = palette.text
		addStroke(button, palette.border)
	end
	addCorner(button, SPACE_2)
	button.MouseEnter:Connect(function()
		if kind == "primary" then
			button.BackgroundColor3 = palette.accentHover
		elseif kind == "secondary" then
			button.BackgroundColor3 = palette.buttonHover
		end
	end)
	button.MouseLeave:Connect(function()
		if kind == "primary" then
			button.BackgroundColor3 = palette.accent
		elseif kind == "secondary" then
			button.BackgroundColor3 = palette.button
		end
	end)
	button.MouseButton1Click:Connect(onClick)
	button.Parent = parent
end

local function createCodeCell(
	parent: Instance,
	palette: Palette,
	x: number,
	codeColumnWidth: number,
	lineNumber: number?,
	text: string?,
	prefix: string,
	tone: "context" | "added" | "deleted"
)
	local background = Instance.new("Frame")
	background.BorderSizePixel = 0
	background.Position = UDim2.fromOffset(x, 0)
	background.Size = UDim2.fromOffset(LINE_GUTTER_WIDTH + codeColumnWidth, CODE_ROW_HEIGHT)
	if tone == "added" then
		background.BackgroundColor3 = palette.diffAddedBackground
	elseif tone == "deleted" then
		background.BackgroundColor3 = palette.diffDeletedBackground
	else
		background.BackgroundColor3 = palette.diffBackground
	end
	background.Parent = parent

	local number = Instance.new("TextLabel")
	number.BackgroundColor3 = palette.diffHeader:Lerp(background.BackgroundColor3, 0.35)
	number.BorderSizePixel = 0
	number.Font = MONO
	number.Size = UDim2.fromOffset(LINE_GUTTER_WIDTH, CODE_ROW_HEIGHT)
	number.Text = if lineNumber then tostring(lineNumber) else ""
	number.TextColor3 = palette.diffGutter
	number.TextSize = 10
	number.TextXAlignment = Enum.TextXAlignment.Right
	number.Parent = background

	local numberPadding = Instance.new("UIPadding")
	numberPadding.PaddingRight = UDim.new(0, SPACE_2)
	numberPadding.Parent = number

	local code = Instance.new("TextLabel")
	code.BackgroundTransparency = 1
	code.Font = MONO
	code.Position = UDim2.fromOffset(LINE_GUTTER_WIDTH + SPACE_3, 0)
	code.Size = UDim2.fromOffset(codeColumnWidth - SPACE_4, CODE_ROW_HEIGHT)
	code.Text = if text then prefix .. text else ""
	code.TextColor3 = if tone == "added"
		then palette.diffAddedText
		elseif tone == "deleted" then palette.diffDeletedText
		else palette.diffText
	code.TextSize = 11
	code.TextTruncate = Enum.TextTruncate.AtEnd
	code.TextWrapped = false
	code.TextXAlignment = Enum.TextXAlignment.Left
	code.Parent = background
end

local function createSplitRow(
	parent: Instance,
	palette: Palette,
	y: number,
	codeColumnWidth: number,
	splitCanvasWidth: number,
	oldNumber: number?,
	oldText: string?,
	oldTone: "context" | "deleted",
	newNumber: number?,
	newText: string?,
	newTone: "context" | "added"
): number
	local row = Instance.new("Frame")
	row.BackgroundColor3 = palette.diffBackground
	row.BorderSizePixel = 0
	row.Position = UDim2.fromOffset(0, y)
	row.Size = UDim2.fromOffset(splitCanvasWidth, CODE_ROW_HEIGHT)
	row.Parent = parent

	createCodeCell(
		row,
		palette,
		0,
		codeColumnWidth,
		oldNumber,
		oldText,
		if oldTone == "deleted" then "- " else "  ",
		oldTone
	)
	local rightX = LINE_GUTTER_WIDTH + codeColumnWidth + SPLIT_DIVIDER_WIDTH
	createCodeCell(
		row,
		palette,
		rightX,
		codeColumnWidth,
		newNumber,
		newText,
		if newTone == "added" then "+ " else "  ",
		newTone
	)

	local divider = Instance.new("Frame")
	divider.BackgroundColor3 = palette.diffBorder
	divider.BorderSizePixel = 0
	divider.Position = UDim2.fromOffset(LINE_GUTTER_WIDTH + codeColumnWidth, 0)
	divider.Size = UDim2.fromOffset(SPLIT_DIVIDER_WIDTH, CODE_ROW_HEIGHT)
	divider.Parent = row
	return y + CODE_ROW_HEIGHT
end

local function createHunkRow(
	parent: Instance,
	palette: Palette,
	y: number,
	splitCanvasWidth: number,
	text: string
): number
	local row = Instance.new("TextLabel")
	row.BackgroundColor3 = palette.diffHunkBackground
	row.BorderSizePixel = 0
	row.Font = FONT_MEDIUM
	row.Position = UDim2.fromOffset(0, y)
	row.Size = UDim2.fromOffset(splitCanvasWidth, HUNK_ROW_HEIGHT)
	row.Text = "  " .. text
	row.TextColor3 = palette.diffGutter
	row.TextSize = 11
	row.TextXAlignment = Enum.TextXAlignment.Left
	row.Parent = parent
	return y + HUNK_ROW_HEIGHT
end

local function renderSplitDiff(parent: ScrollingFrame, palette: Palette, file: ProposalFile, viewportWidth: number)
	clear(parent)
	local codeColumnWidth =
		math.max(MIN_CODE_COLUMN_WIDTH, math.floor((viewportWidth - LINE_GUTTER_WIDTH * 2 - SPLIT_DIVIDER_WIDTH) / 2))
	local splitCanvasWidth = (LINE_GUTTER_WIDTH + codeColumnWidth) * 2 + SPLIT_DIVIDER_WIDTH
	local canvas = Instance.new("Frame")
	canvas.Name = "SplitCanvas"
	canvas.BackgroundColor3 = palette.diffBackground
	canvas.BorderSizePixel = 0
	canvas.Size = UDim2.fromOffset(splitCanvasWidth, CODE_HEADER_HEIGHT)
	canvas.Parent = parent

	local columnHeader = Instance.new("Frame")
	columnHeader.BackgroundColor3 = palette.diffHeader
	columnHeader.BorderSizePixel = 0
	columnHeader.Size = UDim2.fromOffset(splitCanvasWidth, CODE_HEADER_HEIGHT)
	columnHeader.Parent = canvas

	local original = Instance.new("TextLabel")
	original.BackgroundTransparency = 1
	original.Font = FONT_MEDIUM
	original.Position = UDim2.fromOffset(SPACE_4, 0)
	original.Size = UDim2.fromOffset(LINE_GUTTER_WIDTH + codeColumnWidth - SPACE_4, CODE_HEADER_HEIGHT)
	original.Text = "Original"
	original.TextColor3 = palette.diffGutter
	original.TextSize = 11
	original.TextXAlignment = Enum.TextXAlignment.Left
	original.Parent = columnHeader

	local proposed = original:Clone() :: TextLabel
	proposed.Position = UDim2.fromOffset(LINE_GUTTER_WIDTH + codeColumnWidth + SPACE_4, 0)
	proposed.Text = "Proposed"
	proposed.Parent = columnHeader

	local headerDivider = Instance.new("Frame")
	headerDivider.BackgroundColor3 = palette.diffBorder
	headerDivider.BorderSizePixel = 0
	headerDivider.Position = UDim2.fromOffset(LINE_GUTTER_WIDTH + codeColumnWidth, 0)
	headerDivider.Size = UDim2.fromOffset(SPLIT_DIVIDER_WIDTH, CODE_HEADER_HEIGHT)
	headerDivider.Parent = columnHeader

	local y = CODE_HEADER_HEIGHT
	for _, hunk in file.patch.hunks do
		y = createHunkRow(
			canvas,
			palette,
			y,
			splitCanvasWidth,
			string.format("@@ -%d,%d +%d,%d @@", hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines)
		)
		local oldLine = hunk.oldStart
		local newLine = hunk.newStart
		local index = 1
		while index <= #hunk.lines do
			local rawLine = hunk.lines[index]
			if rawLine == "\\ No newline at end of file" then
				index += 1
				continue
			end
			local prefix = string.sub(rawLine, 1, 1)
			if prefix == " " then
				local text = string.sub(rawLine, 2)
				y = createSplitRow(
					canvas,
					palette,
					y,
					codeColumnWidth,
					splitCanvasWidth,
					oldLine,
					text,
					"context",
					newLine,
					text,
					"context"
				)
				oldLine += 1
				newLine += 1
				index += 1
			elseif prefix == "-" then
				local deleted: { string } = {}
				while index <= #hunk.lines and string.sub(hunk.lines[index], 1, 1) == "-" do
					table.insert(deleted, string.sub(hunk.lines[index], 2))
					index += 1
				end
				local added: { string } = {}
				while index <= #hunk.lines and string.sub(hunk.lines[index], 1, 1) == "+" do
					table.insert(added, string.sub(hunk.lines[index], 2))
					index += 1
				end
				for pairIndex = 1, math.max(#deleted, #added) do
					local oldText = deleted[pairIndex]
					local newText = added[pairIndex]
					y = createSplitRow(
						canvas,
						palette,
						y,
						codeColumnWidth,
						splitCanvasWidth,
						if oldText then oldLine else nil,
						oldText,
						if oldText then "deleted" else "context",
						if newText then newLine else nil,
						newText,
						if newText then "added" else "context"
					)
					if oldText then
						oldLine += 1
					end
					if newText then
						newLine += 1
					end
				end
			elseif prefix == "+" then
				y = createSplitRow(
					canvas,
					palette,
					y,
					codeColumnWidth,
					splitCanvasWidth,
					nil,
					nil,
					"context",
					newLine,
					string.sub(rawLine, 2),
					"added"
				)
				newLine += 1
				index += 1
			else
				index += 1
			end
		end
	end
	canvas.Size = UDim2.fromOffset(splitCanvasWidth, y)
	parent.CanvasSize = UDim2.fromOffset(splitCanvasWidth, y)
end

function DiffViewer.new(plugin: Plugin, callbacks: Callbacks)
	local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 1240, 720, 860, 480)
	local dockWidget = plugin:CreateDockWidgetPluginGuiAsync("TraceAutofixDiffReviewV2", info)
	dockWidget.Name = "TraceDiffReview"
	dockWidget.Title = "Trace · Review changes"
	dockWidget.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	dockWidget.Enabled = false

	local root = Instance.new("Frame")
	root.Name = "Root"
	root.BorderSizePixel = 0
	root.Size = UDim2.fromScale(1, 1)
	root.Parent = dockWidget

	local self = setmetatable({
		callbacks = callbacks,
		dockWidget = dockWidget,
		proposal = nil :: ProposalDetail?,
		root = root,
		selectedFileIndex = 1,
	}, DiffViewer)

	settings().Studio.ThemeChanged:Connect(function()
		if dockWidget.Enabled and self.proposal then self:_render() end
	end)
	dockWidget:GetPropertyChangedSignal("AbsoluteSize"):Connect(function()
		if dockWidget.Enabled and self.proposal then self:_render() end
	end)
	return self
end

function DiffViewer:hide()
	self.dockWidget.Enabled = false
	self.proposal = nil
end

function DiffViewer:show(proposal: ProposalDetail, fileIndex: number?)
	if #proposal.files == 0 then
		self:hide()
		return
	end
	self.proposal = proposal
	self.selectedFileIndex = math.clamp(fileIndex or 1, 1, #proposal.files)
	self.dockWidget.Enabled = true
	self:_render()
end

function DiffViewer:_render()
	local proposal = self.proposal
	if not proposal or #proposal.files == 0 then
		self:hide()
		return
	end
	local palette = Theme.read()
	clear(self.root)
	self.root.BackgroundColor3 = palette.diffBackground

	local toolbar = Instance.new("Frame")
	toolbar.Name = "ActionBar"
	toolbar.BackgroundColor3 = palette.diffHeader
	toolbar.BorderSizePixel = 0
	toolbar.Size = UDim2.new(1, 0, 0, TOOLBAR_HEIGHT)
	toolbar.Parent = self.root

	local toolbarDivider = Instance.new("Frame")
	toolbarDivider.BackgroundColor3 = palette.diffBorder
	toolbarDivider.BorderSizePixel = 0
	toolbarDivider.Position = UDim2.new(0, 0, 1, -1)
	toolbarDivider.Size = UDim2.new(1, 0, 0, 1)
	toolbarDivider.Parent = toolbar

	local title = Instance.new("TextLabel")
	title.BackgroundTransparency = 1
	title.Font = FONT_MEDIUM
	title.Position = UDim2.fromOffset(SPACE_4, 5)
	title.Size = UDim2.new(1, -390, 0, 20)
	title.Text = proposal.title or proposal.bug.message
	title.TextColor3 = palette.title
	title.TextSize = 15
	title.TextTruncate = Enum.TextTruncate.AtEnd
	title.TextXAlignment = Enum.TextXAlignment.Left
	title.Parent = toolbar

	local subtitle = Instance.new("TextLabel")
	subtitle.BackgroundTransparency = 1
	subtitle.Font = FONT
	subtitle.Position = UDim2.fromOffset(SPACE_4, 27)
	subtitle.Size = UDim2.new(1, -390, 0, 16)
	subtitle.Text = string.format(
		"%d file%s · Applies as one Studio undo action",
		#proposal.files,
		if #proposal.files == 1 then "" else "s"
	)
	subtitle.TextColor3 = palette.muted
	subtitle.TextSize = 10
	subtitle.TextXAlignment = Enum.TextXAlignment.Left
	subtitle.Parent = toolbar

	local actions = Instance.new("Frame")
	actions.BackgroundTransparency = 1
	actions.Position = UDim2.new(1, -368, 0, 9)
	actions.Size = UDim2.fromOffset(352, ACTION_HEIGHT)
	actions.Parent = toolbar
	local actionLayout = Instance.new("UIListLayout")
	actionLayout.FillDirection = Enum.FillDirection.Horizontal
	actionLayout.HorizontalAlignment = Enum.HorizontalAlignment.Right
	actionLayout.Padding = UDim.new(0, SPACE_2)
	actionLayout.SortOrder = Enum.SortOrder.LayoutOrder
	actionLayout.Parent = actions

	createActionButton(actions, palette, "Reject", "danger", 76, 10, function()
		self:hide()
		self.callbacks.onReject(proposal.id)
	end)
	createActionButton(actions, palette, "Regenerate", "secondary", 96, 20, function()
		self:hide()
		self.callbacks.onRetry(proposal.id)
	end)
	createActionButton(actions, palette, "Accept changes", "primary", 126, 30, function()
		ConfirmationModal.show(
			self.root,
			palette,
			"Apply this fix?",
			string.format(
				"Trace will update %d script%s as one undoable Studio action. This is the final confirmation.",
				#proposal.files,
				if #proposal.files == 1 then "" else "s"
			),
			"Apply changes",
			function()
				self:hide()
				self.callbacks.onAccept(proposal.id)
			end
		)
	end)

	local railWidth = if self.dockWidget.AbsoluteSize.X < 900 then FILE_RAIL_COMPACT else FILE_RAIL_WIDE
	local fileRail = Instance.new("Frame")
	fileRail.Name = "ChangedFiles"
	fileRail.BackgroundColor3 = palette.diffHeader
	fileRail.BorderSizePixel = 0
	fileRail.Position = UDim2.fromOffset(0, TOOLBAR_HEIGHT)
	fileRail.Size = UDim2.new(0, railWidth, 1, -TOOLBAR_HEIGHT)
	fileRail.Parent = self.root

	local railDivider = Instance.new("Frame")
	railDivider.BackgroundColor3 = palette.diffBorder
	railDivider.BorderSizePixel = 0
	railDivider.Position = UDim2.new(1, -1, 0, 0)
	railDivider.Size = UDim2.new(0, 1, 1, 0)
	railDivider.Parent = fileRail

	local railTitle = Instance.new("TextLabel")
	railTitle.BackgroundTransparency = 1
	railTitle.Font = FONT_MEDIUM
	railTitle.Position = UDim2.fromOffset(SPACE_3, 0)
	railTitle.Size = UDim2.new(1, -SPACE_8, 0, FILE_HEADER_HEIGHT)
	railTitle.Text = string.format("Changed files  %d", #proposal.files)
	railTitle.TextColor3 = palette.diffText
	railTitle.TextSize = 12
	railTitle.TextXAlignment = Enum.TextXAlignment.Left
	railTitle.Parent = fileRail

	local files = Instance.new("ScrollingFrame")
	files.AutomaticCanvasSize = Enum.AutomaticSize.Y
	files.BackgroundTransparency = 1
	files.BorderSizePixel = 0
	files.CanvasSize = UDim2.new()
	files.Position = UDim2.fromOffset(0, FILE_HEADER_HEIGHT)
	files.ScrollBarThickness = SPACE_1
	files.Size = UDim2.new(1, -1, 1, -FILE_HEADER_HEIGHT)
	files.Parent = fileRail
	local fileList = Instance.new("UIListLayout")
	fileList.Padding = UDim.new()
	fileList.SortOrder = Enum.SortOrder.LayoutOrder
	fileList.Parent = files

	for index, file in proposal.files do
		local additions, deletions = changeCounts(file)
		local fileButton = Instance.new("TextButton")
		fileButton.Name = file.path
		fileButton.AutoButtonColor = false
		fileButton.BackgroundColor3 = palette.diffBorder
		fileButton.BackgroundTransparency = if index == self.selectedFileIndex then 0 else 1
		fileButton.BorderSizePixel = 0
		fileButton.LayoutOrder = index
		fileButton.Size = UDim2.new(1, 0, 0, FILE_ROW_HEIGHT)
		fileButton.Text = ""
		fileButton.Parent = files

		local icon = Instance.new("TextLabel")
		icon.BackgroundTransparency = 1
		icon.BorderSizePixel = 0
		icon.Font = MONO
		icon.Position = UDim2.fromOffset(SPACE_2, 12)
		icon.Size = UDim2.fromOffset(24, 24)
		icon.Text = "<>"
		icon.TextColor3 = if index == self.selectedFileIndex then palette.accent else palette.muted
		icon.TextSize = 9
		icon.Parent = fileButton

		local path = Instance.new("TextLabel")
		path.BackgroundTransparency = 1
		path.Font = MONO
		path.Position = UDim2.fromOffset(40, 5)
		path.Size = UDim2.new(1, -48, 0, 18)
		path.Text = file.path
		path.TextColor3 = palette.diffText
		path.TextSize = 10
		path.TextTruncate = Enum.TextTruncate.AtEnd
		path.TextXAlignment = Enum.TextXAlignment.Left
		path.Parent = fileButton

		local metadata = Instance.new("TextLabel")
		metadata.BackgroundTransparency = 1
		metadata.Font = FONT
		metadata.Position = UDim2.fromOffset(40, 24)
		metadata.Size = UDim2.new(1, -48, 0, 16)
		metadata.Text = string.format("%s  ·  +%d  −%d", file.className, additions, deletions)
		metadata.TextColor3 = palette.diffGutter
		metadata.TextSize = 10
		metadata.TextXAlignment = Enum.TextXAlignment.Left
		metadata.Parent = fileButton

		fileButton.MouseEnter:Connect(function()
			fileButton.BackgroundColor3 = palette.diffHeader:Lerp(palette.diffText, 0.08)
			fileButton.BackgroundTransparency = 0
		end)
		fileButton.MouseLeave:Connect(function()
			fileButton.BackgroundColor3 = palette.diffBorder
			fileButton.BackgroundTransparency = if index == self.selectedFileIndex then 0 else 1
		end)
		fileButton.MouseButton1Click:Connect(function()
			self.selectedFileIndex = index
			self:_render()
		end)
	end

	local selectedFile = proposal.files[self.selectedFileIndex]
	local additions, deletions = changeCounts(selectedFile)
	local main = Instance.new("Frame")
	main.Name = "Diff"
	main.BackgroundColor3 = palette.diffBackground
	main.BorderSizePixel = 0
	main.Position = UDim2.fromOffset(railWidth, TOOLBAR_HEIGHT)
	main.Size = UDim2.new(1, -railWidth, 1, -TOOLBAR_HEIGHT)
	main.Parent = self.root

	local fileHeader = Instance.new("Frame")
	fileHeader.BackgroundColor3 = palette.diffHeader
	fileHeader.BorderSizePixel = 0
	fileHeader.Size = UDim2.new(1, 0, 0, FILE_HEADER_HEIGHT)
	fileHeader.Parent = main

	local selectedPath = Instance.new("TextLabel")
	selectedPath.BackgroundTransparency = 1
	selectedPath.Font = MONO
	selectedPath.Position = UDim2.fromOffset(SPACE_3, 3)
	selectedPath.Size = UDim2.new(1, -24, 0, 19)
	selectedPath.Text = selectedFile.path
	selectedPath.TextColor3 = palette.diffText
	selectedPath.TextSize = 10
	selectedPath.TextTruncate = Enum.TextTruncate.AtEnd
	selectedPath.TextXAlignment = Enum.TextXAlignment.Left
	selectedPath.Parent = fileHeader

	local fileMetadata = Instance.new("TextLabel")
	fileMetadata.BackgroundTransparency = 1
	fileMetadata.Font = FONT
	fileMetadata.Position = UDim2.fromOffset(SPACE_3, 22)
	fileMetadata.Size = UDim2.new(1, -24, 0, 16)
	fileMetadata.Text =
		string.format("%s  ·  +%d additions  ·  −%d deletions", selectedFile.className, additions, deletions)
	fileMetadata.TextColor3 = palette.diffGutter
	fileMetadata.TextSize = 10
	fileMetadata.TextXAlignment = Enum.TextXAlignment.Left
	fileMetadata.Parent = fileHeader

	local diff = Instance.new("ScrollingFrame")
	diff.Name = "SplitDiff"
	diff.BackgroundColor3 = palette.diffBackground
	diff.BorderSizePixel = 0
	diff.CanvasSize = UDim2.new()
	diff.ElasticBehavior = Enum.ElasticBehavior.Never
	diff.Position = UDim2.fromOffset(0, FILE_HEADER_HEIGHT)
	diff.ScrollBarImageColor3 = palette.diffGutter
	diff.ScrollBarThickness = 6
	diff.ScrollingDirection = Enum.ScrollingDirection.XY
	diff.Size = UDim2.new(1, 0, 1, -FILE_HEADER_HEIGHT)
	diff.Parent = main
	local viewportWidth = math.max(1, self.dockWidget.AbsoluteSize.X - railWidth - diff.ScrollBarThickness)
	renderSplitDiff(diff, palette, selectedFile, viewportWidth)
end

return DiffViewer
