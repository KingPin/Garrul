/**
 * Minimal readline-based prompts. No new dependency. Inherits the
 * existing stdio so wrangler subcommands can take over for secret input.
 */
import { createInterface } from "node:readline";

const ask = (question: string): Promise<string> =>
	new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer);
		});
	});

export const confirm = async (
	question: string,
	defaultYes = false,
): Promise<boolean> => {
	const hint = defaultYes ? "[Y/n]" : "[y/N]";
	const answer = (await ask(`${question} ${hint} `)).trim().toLowerCase();
	if (answer === "") return defaultYes;
	return answer === "y" || answer === "yes";
};
