/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';

interface Props {
	children: React.ReactNode;
}

interface State {
	hasError: boolean;
	error?: Error;
}

export class ErrorBoundary extends React.Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { hasError: false };
	}

	static getDerivedStateFromError(error: Error): State {
		return {
			hasError: true,
			error
		};
	}

	override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
		console.error('Error:', error);
		console.error('Error Info:', errorInfo);
	}

	override render(): JSX.Element {
		if (this.state.hasError) {
			return (
				<div className="error-boundary">
					<h2>Something went wrong.</h2>
					<details>
						<summary>Error Details</summary>
						<pre>{this.state.error?.toString()}</pre>
					</details>
				</div>
			);
		}

		return <div>{this.props.children}</div>;
	}
}