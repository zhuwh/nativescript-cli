import { EOL } from "os";
import * as path from "path";
import { PluginNativeDirNames, PODFILE_NAME, NS_BASE_PODFILE } from "../constants";

export class CocoaPodsService implements ICocoaPodsService {
	private static PODFILE_POST_INSTALL_SECTION_NAME = "post_install";
	private static INSTALLER_BLOCK_PARAMETER_NAME = "installer";

	constructor(
		private $cocoaPodsPlatformManager: ICocoaPodsPlatformManager,
		private $fs: IFileSystem,
		private $childProcess: IChildProcess,
		private $errors: IErrors,
		private $xcprojService: IXcprojService,
		private $logger: ILogger,
		private $config: IConfiguration,
		private $xcconfigService: IXcconfigService) { }

	public getPodfileHeader(targetName: string): string {
		return `use_frameworks!${EOL}${EOL}target "${targetName}" do${EOL}`;
	}

	public getPodfileFooter(): string {
		return `${EOL}end`;
	}

	public getProjectPodfilePath(projectRoot: string): string {
		return path.join(projectRoot, PODFILE_NAME);
	}

	public async executePodInstall(projectRoot: string, xcodeProjPath: string): Promise<ISpawnResult> {
		// Check availability
		try {
			await this.$childProcess.exec("which pod");
			await this.$childProcess.exec("which xcodeproj");
		} catch (e) {
			this.$errors.failWithoutHelp("CocoaPods or ruby gem 'xcodeproj' is not installed. Run `sudo gem install cocoapods` and try again.");
		}

		await this.$xcprojService.verifyXcproj({ shouldFail: true });

		this.$logger.info("Installing pods...");
		const podTool = this.$config.USE_POD_SANDBOX ? "sandbox-pod" : "pod";
		// cocoapods print a lot of non-error information on stderr. Pipe the `stderr` to `stdout`, so we won't polute CLI's stderr output.
		const podInstallResult = await this.$childProcess.spawnFromEvent(podTool, ["install"], "close", { cwd: projectRoot, stdio: ['pipe', process.stdout, process.stdout] }, { throwError: false });

		if (podInstallResult.exitCode !== 0) {
			this.$errors.failWithoutHelp(`'${podTool} install' command failed.${podInstallResult.stderr ? " Error is: " + podInstallResult.stderr : ""}`);
		}

		if ((await this.$xcprojService.getXcprojInfo()).shouldUseXcproj) {
			await this.$childProcess.spawnFromEvent("xcproj", ["--project", xcodeProjPath, "touch"], "close");
		}

		return podInstallResult;
	}

	public async mergePodXcconfigFile(projectData: IProjectData, platformData: IPlatformData, opts: IRelease) {
		const podFilesRootDirName = path.join("Pods", "Target Support Files", `Pods-${projectData.projectName}`);
		const podFolder = path.join(platformData.projectRoot, podFilesRootDirName);
		if (this.$fs.exists(podFolder)) {
			const podXcconfigFilePath = opts && opts.release ? path.join(podFolder, `Pods-${projectData.projectName}.release.xcconfig`)
				: path.join(podFolder, `Pods-${projectData.projectName}.debug.xcconfig`);
			const pluginsXcconfigFilePath = this.$xcconfigService.getPluginsXcconfigFilePath(platformData.projectRoot, opts);
			await this.$xcconfigService.mergeFiles(podXcconfigFilePath, pluginsXcconfigFilePath);
		}
	}

	public async applyPodfileFromAppResources(projectData: IProjectData, platformData: IPlatformData): Promise<void> {
		const { projectRoot, normalizedPlatformName } = platformData;
		const mainPodfilePath = path.join(projectData.appResourcesDirectoryPath, normalizedPlatformName, PODFILE_NAME);
		const projectPodfilePath = this.getProjectPodfilePath(projectRoot);
		if (this.$fs.exists(projectPodfilePath) || this.$fs.exists(mainPodfilePath)) {
			await this.applyPodfileToProject(NS_BASE_PODFILE, mainPodfilePath, projectData, projectRoot);
		}
	}

	public async applyPodfileToProject(moduleName: string, podfilePath: string, projectData: IProjectData, nativeProjectPath: string): Promise<void> {
		if (!this.$fs.exists(podfilePath)) {
			this.removePodfileFromProject(moduleName, podfilePath, projectData, nativeProjectPath);
			return;
		}

		const { podfileContent, replacedFunctions, podfilePlatformData } = this.buildPodfileContent(podfilePath, moduleName);
		const pathToProjectPodfile = this.getProjectPodfilePath(nativeProjectPath);
		const projectPodfileContent = this.$fs.exists(pathToProjectPodfile) ? this.$fs.readText(pathToProjectPodfile).trim() : "";

		if (projectPodfileContent.indexOf(podfileContent) === -1) {
			// Remove old occurences of the plugin from the project's Podfile.
			this.removePodfileFromProject(moduleName, podfilePath, projectData, nativeProjectPath);
			let finalPodfileContent = this.$fs.exists(pathToProjectPodfile) ? this.getPodfileContentWithoutTarget(projectData, this.$fs.readText(pathToProjectPodfile)) : "";

			if (podfileContent.indexOf(CocoaPodsService.PODFILE_POST_INSTALL_SECTION_NAME) !== -1) {
				finalPodfileContent = this.addPostInstallHook(replacedFunctions, finalPodfileContent, podfileContent);
			}

			if (podfilePlatformData) {
				finalPodfileContent = this.$cocoaPodsPlatformManager.addPlatformSection(projectData, podfilePlatformData, finalPodfileContent);
			}

			finalPodfileContent = `${podfileContent}${EOL}${finalPodfileContent}`;
			this.saveProjectPodfile(projectData, finalPodfileContent, nativeProjectPath);
		}
	}

	public removePodfileFromProject(moduleName: string, podfilePath: string, projectData: IProjectData, projectRoot: string): void {
		if (this.$fs.exists(this.getProjectPodfilePath(projectRoot))) {
			let projectPodFileContent = this.$fs.readText(this.getProjectPodfilePath(projectRoot));
			// Remove the data between #Begin Podfile and #EndPodfile
			const regExpToRemove = new RegExp(`${this.getPluginPodfileHeader(podfilePath)}[\\s\\S]*?${this.getPluginPodfileEnd()}`, "mg");
			projectPodFileContent = projectPodFileContent.replace(regExpToRemove, "");
			projectPodFileContent = this.removePostInstallHook(moduleName, projectPodFileContent);
			projectPodFileContent = this.$cocoaPodsPlatformManager.removePlatformSection(moduleName, projectPodFileContent, podfilePath);

			const defaultPodfileBeginning = this.getPodfileHeader(projectData.projectName);
			const defaultContentWithPostInstallHook = `${defaultPodfileBeginning}${EOL}${this.getPostInstallHookHeader()}end${EOL}end`;
			const defaultContentWithoutPostInstallHook = `${defaultPodfileBeginning}end`;
			const trimmedProjectPodFileContent = projectPodFileContent.trim();
			if (!trimmedProjectPodFileContent || trimmedProjectPodFileContent === defaultContentWithPostInstallHook || trimmedProjectPodFileContent === defaultContentWithoutPostInstallHook) {
				this.$fs.deleteFile(this.getProjectPodfilePath(projectRoot));
			} else {
				this.$fs.writeFile(this.getProjectPodfilePath(projectRoot), projectPodFileContent);
			}
		}
	}

	public getPluginPodfilePath(pluginData: IPluginData): string {
		const pluginPlatformsFolderPath = pluginData.pluginPlatformsFolderPath(PluginNativeDirNames.iOS);
		const pluginPodFilePath = path.join(pluginPlatformsFolderPath, PODFILE_NAME);
		return pluginPodFilePath;
	}

	private addPostInstallHook(replacedFunctions: IRubyFunction[], finalPodfileContent: string, pluginPodfileContent: string): string {
		const postInstallHookStart = this.getPostInstallHookHeader();
		let postInstallHookContent = "";
		_.each(replacedFunctions, rubyFunction => {
			let functionExecution = rubyFunction.functionName;
			if (rubyFunction.functionParameters && rubyFunction.functionParameters.length) {
				functionExecution = `${functionExecution} ${CocoaPodsService.INSTALLER_BLOCK_PARAMETER_NAME}`;
			}

			postInstallHookContent += `  ${functionExecution}${EOL}`;
		});

		if (postInstallHookContent) {
			const index = finalPodfileContent.indexOf(postInstallHookStart);
			if (index !== -1) {
				finalPodfileContent = finalPodfileContent.replace(postInstallHookStart, `${postInstallHookStart}${postInstallHookContent}`);
			} else {
				if (finalPodfileContent.length > 0) {
					finalPodfileContent += `${EOL}${EOL}`;
				}
				const postInstallHook = `${postInstallHookStart}${postInstallHookContent}end`;
				finalPodfileContent = `${finalPodfileContent}${postInstallHook}`;
			}
		}

		return finalPodfileContent;
	}

	private getPodfileContentWithoutTarget(projectData: IProjectData, projectPodfileContent: string): string {
		const podFileHeader = this.getPodfileHeader(projectData.projectName);

		if (_.startsWith(projectPodfileContent, podFileHeader)) {
			projectPodfileContent = projectPodfileContent.substr(podFileHeader.length);

			const podFileFooter = this.getPodfileFooter();
			// Only remove the final end in case the file starts with the podFileHeader
			if (_.endsWith(projectPodfileContent, podFileFooter)) {
				projectPodfileContent = projectPodfileContent.substr(0, projectPodfileContent.length - podFileFooter.length);
			}
		}

		return projectPodfileContent.trim();
	}

	private saveProjectPodfile(projectData: IProjectData, projectPodfileContent: string, projectRoot: string): void {
		projectPodfileContent = this.getPodfileContentWithoutTarget(projectData, projectPodfileContent);
		const podFileHeader = this.getPodfileHeader(projectData.projectName);
		const podFileFooter = this.getPodfileFooter();
		const contentToWrite = `${podFileHeader}${projectPodfileContent}${podFileFooter}`;
		const projectPodfilePath = this.getProjectPodfilePath(projectRoot);
		this.$fs.writeFile(projectPodfilePath, contentToWrite);
	}

	private removePostInstallHook(moduleName: string, projectPodFileContent: string): string {
		const regExp = new RegExp(`^.*?${this.getHookBasicFuncNameForPlugin(CocoaPodsService.PODFILE_POST_INSTALL_SECTION_NAME, moduleName)}.*?$\\r?\\n`, "gm");
		projectPodFileContent = projectPodFileContent.replace(regExp, "");
		return projectPodFileContent;
	}

	private getHookBasicFuncNameForPlugin(hookName: string, pluginName: string): string {
		// nativescript-hook and nativescript_hook should have different names, so replace all _ with ___ first and then replace all special symbols with _
		// This will lead to a clash in case plugins are called nativescript-hook and nativescript___hook
		const replacedPluginName = pluginName.replace(/_/g, "___").replace(/[^A-Za-z0-9_]/g, "_");
		return `${hookName}${replacedPluginName}`;
	}

	private replaceHookContent(hookName: string, podfileContent: string, pluginName: string): { replacedContent: string, newFunctions: IRubyFunction[] } {
		const hookStart = `${hookName} do`;

		const hookDefinitionRegExp = new RegExp(`${hookStart} *(\\|(\\w+)\\|)?`, "g");
		const newFunctions: IRubyFunction[] = [];

		const replacedContent = podfileContent.replace(hookDefinitionRegExp, (substring: string, firstGroup: string, secondGroup: string, index: number): string => {
			const newFunctionName = `${this.getHookBasicFuncNameForPlugin(hookName, pluginName)}_${newFunctions.length}`;
			let newDefinition = `def ${newFunctionName}`;

			const rubyFunction: IRubyFunction = { functionName: newFunctionName };
			// firstGroup is the block parameter, secondGroup is the block parameter name.
			if (firstGroup && secondGroup) {
				newDefinition = `${newDefinition} (${secondGroup})`;
				rubyFunction.functionParameters = secondGroup;
			}

			newFunctions.push(rubyFunction);
			return newDefinition;
		});

		return { replacedContent, newFunctions };
	}

	private getPluginPodfileHeader(pluginPodFilePath: string): string {
		return `# Begin Podfile - ${pluginPodFilePath}`;
	}

	private getPluginPodfileEnd(): string {
		return `# End Podfile${EOL}`;
	}

	private getPostInstallHookHeader() {
		return `${CocoaPodsService.PODFILE_POST_INSTALL_SECTION_NAME} do |${CocoaPodsService.INSTALLER_BLOCK_PARAMETER_NAME}|${EOL}`;
	}

	private buildPodfileContent(pluginPodFilePath: string, pluginName: string): { podfileContent: string, replacedFunctions: IRubyFunction[], podfilePlatformData: IPodfilePlatformData } {
		const pluginPodfileContent = this.$fs.readText(pluginPodFilePath);
		const data = this.replaceHookContent(CocoaPodsService.PODFILE_POST_INSTALL_SECTION_NAME, pluginPodfileContent, pluginName);
		const { replacedContent, podfilePlatformData } = this.$cocoaPodsPlatformManager.replacePlatformRow(data.replacedContent, pluginPodFilePath);

		return {
			podfileContent: `${this.getPluginPodfileHeader(pluginPodFilePath)}${EOL}${replacedContent}${EOL}${this.getPluginPodfileEnd()}`,
			replacedFunctions: data.newFunctions,
			podfilePlatformData
		};
	}

}

$injector.register("cocoapodsService", CocoaPodsService);
