/* eslint-disable code-import-patterns */
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { LocalLogger, RTVLogger } from 'vs/editor/contrib/rtv/RTVLogger';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';

// Helper functions
function getOSEnvVariable(v: string): string {
	let result = process.env[v];
	if (result === undefined) {
		throw new Error('OS environment variable ' + v + ' is not defined.');
	}
	return result;
}

let PY3 = getOSEnvVariable('PYTHON3');
let RUNPY = getOSEnvVariable('RUNPY');
let SYNTH = getOSEnvVariable('SYNTH');
let SCALA = getOSEnvVariable('SCALA');

export interface Process {
	onExit(fn: (exitCode: any, result?: string) => void): void;
	onStdout(fn: (data: any) => void): void;
	onStderr(fn: (data: any) => void): void;
	kill(): void;
}

class RunpyProcess implements Process {
	constructor(private file: string,
		private p: child_process.ChildProcessWithoutNullStreams) {
	}

	onStdout(fn: (data: any) => void): void {
		this.p.stdout.on('data', fn);
	}

	onStderr(fn: (data: any) => void): void {
		this.p.stderr.on('data', fn);
	}

	kill() {
		this.p.kill();
	}

	onExit(fn: (exitCode: any, result?: string) => void): void {
		this.p.on('exit', (exitCode, _) => {
			let result = undefined;

			if (exitCode === 0) {
				result = fs.readFileSync(this.file + '.out').toString();
			}

			fn(exitCode, result);
		});
	}
}

class SynthProcess implements Process {
	constructor(private file: string,
		private process: child_process.ChildProcessWithoutNullStreams) { }

	onStdout(fn: (data: any) => void): void {
		this.process.stdout.on('data', fn);
	}

	onStderr(fn: (data: any) => void): void {
		this.process.stderr.on('data', fn);
	}

	kill() {
		this.process.kill();
	}

	onExit(fn: (exitCode: any, result?: string) => void): void {
		this.process.on('close', (exitCode) => {
			let result = undefined;

			if (exitCode === 0) {
				result = fs.readFileSync(this.file + '.out').toString();
			}

			fn(exitCode, result);
		});
	}
}

export function runProgram(program: string): Process {
	const file: string = os.tmpdir() + path.sep + 'tmp.py';
	fs.writeFileSync(file, program);
	const local_process = child_process.spawn(PY3, [RUNPY, file]);
	return new RunpyProcess(file, local_process);
}

export function synthesizeSnippet(problem: string): Process {
	const example_fname = os.tmpdir() + path.sep + 'synth_example.json';
	fs.writeFileSync(example_fname, problem);
	let c = child_process.spawn(SCALA, [SYNTH, example_fname]);
	return new SynthProcess(example_fname, c);
}

export function getLogger(editor: ICodeEditor): RTVLogger {
	return new LocalLogger(editor);
}

export const EOL: string = os.EOL;
