import * as path from 'path';
import * as tslint from 'tslint';
import * as ts_module from 'typescript/lib/tsserverlibrary';
import { pluginId, TSLINT_ERROR_CODE, TSLINT_ERROR_SOURCE } from './config';
import { ConfigFileWatcher } from './ConfigFileWatcher';
import { Logger } from './Logger';
import { RunResult, TsLintRunner } from './runner';
import { Settings } from './Settings';

function fixRelativeConfigFilePath(config: Settings, projectRoot: string): Settings {
    if (!config.configFile) {
        return config;
    }
    if (path.isAbsolute(config.configFile)) {
        return config;
    }
    config.configFile = path.join(projectRoot, config.configFile);
    return config;
}

// key to identify a rule failure
function computeKey(start: number, end: number): string {
    return `[${start},${end}]`;
}


export class TSLintPlugin {
    private readonly codeFixActions = new Map<string, Map<string, tslint.RuleFailure>>();
    private readonly logger: Logger;
    private readonly project: ts_module.server.Project;
    private readonly configFileWatcher: ConfigFileWatcher;
    private config: Settings;
    private readonly runner: TsLintRunner;

    public constructor(
        private readonly ts: typeof ts_module,
        info: ts.server.PluginCreateInfo
    ) {
        this.logger = Logger.forPlugin(info);
        this.project = info.project;

        this.logger.info('loaded');
        this.config = fixRelativeConfigFilePath(info.config, info.project.getCurrentDirectory());

        this.runner = new TsLintRunner(() => { });

        // Set up decorator
        const proxy = Object.create(null) as ts.LanguageService;
        const oldLS = info.languageService;
        for (const k in oldLS) {
            (<any>proxy)[k] = function () {
                return (<any>oldLS)[k].apply(oldLS, arguments);
            }
        }

        // Watch config file for changes
        if (info.project instanceof ts.server.ConfiguredProject && ts.sys.watchFile) {
            const configFile = info.project.getConfigFilePath();
            this.logger.info(`Found configured project: ${configFile}`);

            ts.sys.watchFile(configFile, (_fileName: string, eventKind: ts.FileWatcherEventKind) => {
                if (eventKind !== ts.FileWatcherEventKind.Changed) {
                    return;
                }

                this.logger.info('TSConfig file changed');

                const configFileResult = ts.readConfigFile(configFile, ts.sys.readFile);
                if (configFileResult.error || !configFileResult.config) {
                    this.logger.info(`Error reading config file: ${configFileResult.error}`);
                    return;
                }

                if (!configFileResult.config.compilerOptions || !Array.isArray(configFileResult.config.compilerOptions.plugins)) {
                    return;
                }

                const pluginSettings = (configFileResult.config.compilerOptions.plugins as Array<any>).find(x => x.name === pluginId);
                if (!pluginSettings) {
                    return;
                }

                this.logger.info(`Updating config settings: ${JSON.stringify(pluginSettings)}`);
                this.config = fixRelativeConfigFilePath(pluginSettings, info.project.getCurrentDirectory());
                info.project.refreshDiagnostics();
            });
        }

        this.configFileWatcher = new ConfigFileWatcher(ts, filePath => {
            this.logger.info('TSlint file changed');
            this.runner.onConfigFileChange(filePath);
            info.project.refreshDiagnostics();
        });
    }

    replacementsAreEmpty(fix: tslint.Fix | undefined): boolean {
        // in tslint 4 a Fix has a replacement property witht the Replacements
        if ((<any>fix).replacements) {
            return (<any>fix).replacements.length === 0;
        }
        // tslint 5
        if (Array.isArray(fix)) {
            return fix.length === 0;
        }
        return false;
    }

    recordCodeAction(problem: tslint.RuleFailure, file: ts.SourceFile) {
        let fix: tslint.Fix | undefined = undefined;

        // tslint can return a fix with an empty replacements array, these fixes are ignored
        if (problem.getFix && problem.getFix() && !this.replacementsAreEmpty(problem.getFix())) { // tslint fixes are not available in tslint < 3.17
            fix = problem.getFix(); // createAutoFix(problem, document, problem.getFix());
        }

        if (!fix) {
            return;
        }

        let documentAutoFixes: Map<string, tslint.RuleFailure> | undefined = this.codeFixActions.get(file.fileName);
        if (!documentAutoFixes) {
            documentAutoFixes = new Map<string, tslint.RuleFailure>();
            this.codeFixActions.set(file.fileName, documentAutoFixes);
        }
        documentAutoFixes.set(computeKey(problem.getStartPosition().getPosition(), problem.getEndPosition().getPosition()), problem);
    }

    convertReplacementToTextChange(repl: tslint.Replacement): ts.TextChange {
        return {
            newText: repl.text,
            span: { start: repl.start, length: repl.length }
        };
    }

    problemToFileTextChange(problem: tslint.RuleFailure, fileName: string): ts_module.FileTextChanges {
        let fix = problem.getFix();
        let replacements: tslint.Replacement[] = getReplacements(fix);

        return {
            fileName: fileName,
            textChanges: replacements.map(each => this.convertReplacementToTextChange(each)),
        }
    }

    addRuleFailureFix(fixes: ts_module.CodeAction[], problem: tslint.RuleFailure, fileName: string) {
        fixes.push({
            description: `Fix '${problem.getRuleName()}'`,
            changes: [this.problemToFileTextChange(problem, fileName)]
        });
    }

    /* Generate a code action that fixes all instances of ruleName.  */
    addRuleFailureFixAll(fixes: ts_module.CodeAction[], ruleName: string, problems: Map<string, tslint.RuleFailure>, fileName: string) {
        const changes: ts_module.FileTextChanges[] = [];

        for (const problem of problems.values()) {
            if (problem.getRuleName() === ruleName) {
                changes.push(this.problemToFileTextChange(problem, fileName));
            }
        }

        /* No need for this action if there's only one instance.  */
        if (changes.length < 2) {
            return;
        }

        fixes.push({
            description: `Fix all '${ruleName}'`,
            changes: changes,
        });
    }

    addDisableRuleFix(fixes: ts_module.CodeAction[], problem: tslint.RuleFailure, fileName: string, file: ts_module.SourceFile) {
        fixes.push({
            description: `Disable rule '${problem.getRuleName()}'`,
            changes: [{
                fileName: fileName,
                textChanges: [{
                    newText: `// tslint:disable-next-line:${problem.getRuleName()}\n`,
                    span: { start: file.getLineStarts()[problem.getStartPosition().getLineAndCharacter().line], length: 0 }
                }]
            }]
        });
    }

    addAllAutoFixable(fixes: ts_module.CodeAction[], documentFixes: Map<string, tslint.RuleFailure>, fileName: string) {
        const allReplacements = this.runner.getNonOverlappingReplacements(Array.from(documentFixes.values()));
        fixes.push({
            description: `Fix all auto-fixable tslint failures`,
            changes: [{
                fileName: fileName,
                textChanges: allReplacements.map(each => this.convertReplacementToTextChange(each))
            }]
        });
    }

    decorate(languageService: ts.LanguageService) {
        const oldGetSemanticDiagnostics = languageService.getSemanticDiagnostics.bind(languageService);
        languageService.getSemanticDiagnostics = (fileName: string) => {
            const diagnostics = oldGetSemanticDiagnostics(fileName);

            if (this.config.suppressWhileTypeErrorsPresent && diagnostics.length > 0) {
                return diagnostics;
            }

            try {
                this.logger.info(`Computing tslint semantic diagnostics...`);
                if (this.codeFixActions.has(fileName)) {
                    this.codeFixActions.delete(fileName);
                }

                if (this.config.ignoreDefinitionFiles === true && fileName.endsWith('.d.ts')) {
                    return diagnostics;
                }

                let result: RunResult;
                try { // protect against tslint crashes
                    result = this.runner.runTsLint(fileName, this.getProgram(), {
                        configFile: this.config.configFile,
                        ignoreDefinitionFiles: this.config.ignoreDefinitionFiles
                    });
                    if (result.configFilePath) {
                        this.configFileWatcher.ensureWatching(result.configFilePath);
                    }
                } catch (err) {
                    let errorMessage = `unknown error`;
                    if (typeof err.message === 'string' || err.message instanceof String) {
                        errorMessage = <string>err.message;
                    }
                    this.logger.info('tslint error ' + errorMessage);
                    return diagnostics;
                }

                const file = this.getProgram().getSourceFile(fileName)!;

                for (const warning of result.warnings) {
                    this.logger.info(`[tslint] ${warning}`);
                    diagnostics.push({
                        code: TSLINT_ERROR_CODE,
                        source: TSLINT_ERROR_SOURCE,
                        category: this.ts.DiagnosticCategory.Error,
                        file,
                        start: 0,
                        length: 1,
                        messageText: warning,
                    });
                }

                const tslintProblems = this.runner.filterProblemsForFile(fileName, result.lintResult.failures);
                for (const problem of tslintProblems) {
                    diagnostics.push(this.makeDiagnostic(problem, file));
                    this.recordCodeAction(problem, file);
                }
            } catch (e) {
                this.logger.info(`tslint-language service error: ${e.toString()}`);
                this.logger.info(`Stack trace: ${e.stack}`);
            }

            return diagnostics;
        };

        const getCodeFixesAtPosition = languageService.getCodeFixesAtPosition.bind(languageService);

        languageService.getCodeFixesAtPosition = (fileName: string, start: number, end: number, errorCodes: number[], formatOptions: ts.FormatCodeSettings, userPreferences: ts.UserPreferences): ReadonlyArray<ts.CodeFixAction> => {
            let prior = getCodeFixesAtPosition(fileName, start, end, errorCodes, formatOptions, userPreferences);
            if (this.config.suppressWhileTypeErrorsPresent && prior.length > 0) {
                return prior;
            }

            this.logger.info("tslint-language-service getCodeFixes " + errorCodes[0]);
            let documentFixes = this.codeFixActions.get(fileName);

            if (documentFixes) {
                const fixes = prior ? [...prior] : [];

                let problem = documentFixes.get(computeKey(start, end));
                if (problem) {
                    this.addRuleFailureFix(fixes, problem, fileName);
                    this.addRuleFailureFixAll(fixes, problem.getRuleName(), documentFixes, fileName);
                }
                this.addAllAutoFixable(fixes, documentFixes, fileName);
                if (problem) {
                    this.addDisableRuleFix(fixes, problem, fileName, this.getProgram().getSourceFile(fileName)!);
                }

                return fixes;
            }

            return prior;
        };

        return languageService;
    }

    getProgram() {
        return this.project.getLanguageService().getProgram()!;
    }


    makeDiagnostic(problem: tslint.RuleFailure, file: ts.SourceFile): ts.Diagnostic {
        const message = (problem.getRuleName() !== null)
            ? `${problem.getFailure()} (${problem.getRuleName()})`
            : `${problem.getFailure()}`;

        const category = this.getDiagnosticCategory(problem);

        return {
            file: file,
            start: problem.getStartPosition().getPosition(),
            length: problem.getEndPosition().getPosition() - problem.getStartPosition().getPosition(),
            messageText: message,
            category: category,
            source: TSLINT_ERROR_SOURCE,
            code: TSLINT_ERROR_CODE
        };
    }

    getDiagnosticCategory(problem: tslint.RuleFailure): ts.DiagnosticCategory {
        if (this.config.alwaysShowRuleFailuresAsWarnings === true) {
            return this.ts.DiagnosticCategory.Warning;
        } else if (problem.getRuleSeverity && problem.getRuleSeverity() === 'error') {
            // tslint5 supports to assign severities to rules
            return this.ts.DiagnosticCategory.Error;
        }
        return this.ts.DiagnosticCategory.Warning;
    }

}



function getReplacements(fix: tslint.Fix | undefined): tslint.Replacement[] {
    let replacements: tslint.Replacement[] | null = null;
    // in tslint4 a Fix has a replacement property with the Replacements
    if ((<any>fix).replacements) {
        // tslint4
        replacements = (<any>fix).replacements;
    } else {
        // in tslint 5 a Fix is a Replacement | Replacement[]                  
        if (!Array.isArray(fix)) {
            replacements = [<any>fix];
        } else {
            replacements = fix;
        }
    }
    return replacements || [];
}