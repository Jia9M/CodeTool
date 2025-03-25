const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

async function getSnippetFiles(context) {
	const snippetsFolderPath = path.join(context.extensionPath, 'snippets');
	try {
		const files = await fs.promises.readdir(snippetsFolderPath);
		const snippetFiles = files.filter(file => path.extname(file).toLowerCase() === '.json');
		return snippetFiles.map(file => path.join(snippetsFolderPath, file));
	} catch (error) {
		console.error('Error reading snippet files:', error);
		return [];
	}
}

  async function getSnippetsFromFile(filePath) {
	try {
		const snippetsData = fs.readFileSync(filePath, 'utf8');
		const snippets = JSON.parse(snippetsData);
		return snippets; // 返回整个 snippets 对象
	} catch (error) {
		console.error('Error reading snippets from file:', error);
		return {};
	}
}

function getOptionsContent(snippetFiles) {
	const optionsHtml = snippetFiles.map(snippetFile => {
	const fileName = path.basename(snippetFile, '.json');
	return `<li><button data-file="${snippetFile}">${fileName}</button></li>`;
	}).join('');

	return `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Snippet Options</title>
	</head>
	<body>
		<h1>Select Snippet File</h1>
		<ul>
		${optionsHtml}
		</ul>
		<script>
		document.addEventListener('DOMContentLoaded', function() {
			const vscode = acquireVsCodeApi();

			document.querySelector('ul').addEventListener('click', function(event) {
			if (event.target.tagName === 'BUTTON') {
				const snippetFile = event.target.getAttribute('data-file');
				sendMessage(snippetFile);
			}
			});

			function sendMessage(snippetFile) {
			try {
				vscode.postMessage({ command: 'selectSnippetFile', file: snippetFile });
			} catch (error) {
				console.error('Error calling vscode.postMessage:', error);
			}
			}
		});
		</script>
	</body>
	</html>
	`;
}

function getWebviewContent(snippets, snippetFile) {
	const buttonsHtml = Object.keys(snippets).map(snippetName => `
		<li><button data-snippet="${snippetName}">${snippets[snippetName].description || snippetName}</button></li>
	`).join('');

	return `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Preset Code</title>
	</head>
	<body>
		<h1>Code Snippets - ${path.basename(snippetFile, '.json')}</h1>
		<ul>
			${buttonsHtml}
		</ul>
		<button id="backButton">返回</button>
		<script>
			document.addEventListener('DOMContentLoaded', function() {
			const vscode = acquireVsCodeApi();
			document.querySelector('ul').addEventListener('click', function(event) {
				if (event.target.tagName === 'BUTTON') {
					const snippetName = event.target.getAttribute('data-snippet');
					sendMessage(snippetName);
				}
			});

			document.getElementById('backButton').addEventListener('click', function() {
				sendMessage('back');
			});

			function sendMessage(data) {
				try {
					vscode.postMessage({ command: 'insertSnippet', snippet: data });
				} catch (error) {
					console.error('Error calling vscode.postMessage:', error);
				}
			}
		});
		</script>
	</body>
</html>
	`;
}

let snippets = {}; // 存储 snippets 数据
let pendingSnippet = null; // 存储待插入的代码片段
let pendingPosition = null; // 存储待插入的位置
let editorFocusListener = null; // 存储编辑器焦点变化监听器
let currentSnippetFile = null; // 存储当前选中的 snippet 文件路径
let activeEditor = null; // 存储活动编辑器实例

function showWebview(context) {
	try {
		const panel = vscode.window.createWebviewPanel(
			'presetCode',
			'Preset Code',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(context.extensionPath)]
			}
		);

		getSnippetFiles(context).then(snippetFiles => {
			panel.webview.html = getOptionsContent(snippetFiles);
			console.log('Initial options sent to webview:', snippetFiles);
		}).catch(error => {
			console.error('Error fetching snippet files:', error);
		});

		panel.webview.onDidReceiveMessage(
			message => {
				console.log('Received raw message in extension:', message);
				try {
					switch (message.command) {
						case 'selectSnippetFile':
							currentSnippetFile = message.file;
							getSnippetsFromFile(currentSnippetFile).then(snippetsData => {
								snippets = snippetsData; // 存储整个 snippets 对象
								panel.webview.html = getWebviewContent(snippets, currentSnippetFile);
								console.log('Sent snippets to webview:', snippets);
							}).catch(error => {
								console.error('Error fetching snippets:', error);
							});
							return;

						case 'insertSnippet':
							if (message.snippet === 'back') {
								getSnippetFiles(context).then(snippetFiles => {
									panel.webview.html = getOptionsContent(snippetFiles);
									console.log('Returned to options:', snippetFiles);
								}).catch(error => {
									console.error('Error fetching snippet files:', error);
								});
								return;
							}

							const snippetName = message.snippet; // 代码片段的名称
							const snippetContent = snippets[snippetName]?.body || ''; // 获取实际的代码内容

							// 强制切换焦点到编辑器窗口
							vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup').then(() => {
								setTimeout(() => { // 增加延迟，确保焦点已切换
									const editor = vscode.window.activeTextEditor;
									if (editor) {
										// 如果有活动编辑器，存储当前编辑器实例和光标位置
										activeEditor = editor;
										pendingPosition = editor.selection.active;
										// 插入代码片段
										insertSnippet(snippetContent, pendingPosition);
									} else {
										// 如果没有活动编辑器，提示用户并等待编辑器激活
										pendingSnippet = snippetContent;
										if (!editorFocusListener) {
											editorFocusListener = vscode.window.onDidChangeActiveTextEditor(activeEditor => {
												if (activeEditor && pendingSnippet) {
													// 存储当前编辑器实例和光标位置
													activeEditor = activeEditor;
													pendingPosition = activeEditor.selection.active;
													// 插入代码片段
													insertSnippet(pendingSnippet, pendingPosition);

													// 清理状态
													pendingSnippet = null;
													pendingPosition = null;
													if (editorFocusListener) {
														editorFocusListener.dispose();
														editorFocusListener = null;
													}
												}
											});
										}
										// 尝试获取当前光标位置
										if ((activeEditor && activeEditor.selection) || pendingPosition) {
											pendingPosition = pendingPosition || activeEditor.selection.active;
											insertSnippet(snippetContent, pendingPosition);
										} else {
											vscode.window.showInformationMessage('请先打开或切换到一个编辑器窗口');
										}
									}
								}, 100); // 延迟 100ms
							});
							return;
					}
				} catch (error) {
					console.error('Error handling message in extension:', error);
				}
			},
			undefined,
			context.subscriptions
		);

		// 监听编辑器焦点变化，更新活动编辑器实例
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor) {
				activeEditor = editor;
				pendingPosition = editor.selection.active;
			}
		}, null, context.subscriptions);
	} catch (error) {
		console.error('Error activating extension:', error);
	}
}

function insertSnippet(snippet, position) {
	try {
		if (!activeEditor) {
			vscode.window.showInformationMessage('没有活动的编辑器');
			return;
		}

		// 如果 snippet 是数组，则将其转换为字符串
		const snippetString = Array.isArray(snippet) ? snippet.join('\n') : snippet;

		// 使用 vscode.SnippetString 处理代码片段
		const snippetToInsert = new vscode.SnippetString(snippetString);

		// 插入代码片段到指定位置
		activeEditor.insertSnippet(snippetToInsert, position).then(success => {
			if (success) {
				console.log('Snippet inserted successfully:', snippetString);
			} else {
				console.error('Failed to insert snippet');
			}
		});
	} catch (error) {
		console.error('Error inserting snippet:', error);
	}
}

exports.activate = function(context) {
	console.log('恭喜，您的扩展“ShowSnippets”已被激活！');
	// 注册命令
	context.subscriptions.push(vscode.commands.registerCommand('extension.showWebview', function () {
		showWebview(context);
	}));
};

exports.deactivate = function() {
	console.log('您的扩展“ShowSnippets”已被释放！')
};