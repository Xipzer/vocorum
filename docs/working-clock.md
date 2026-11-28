# The working clock

`GET /client/overview` and `SESSION_STATE` carry `runStartedAt`, in Unix milliseconds, for a running root execution when its start is known. The response or frame carries `server_time_ms`. Sample the difference on receipt and advance it with a monotonic clock. Discard samples on disconnect. If either field is absent, show the status without an elapsed time. `since` describes a display state, not the execution start.

The clock comes from the durable `session.execution.started` event's `created` value in an existing local recorder. The hub checks the thread-to-root binding and ignores child executions. A queue receipt, a delivered item, a tool and typing cannot start a clock. A device reconnect can resume from the recorded start, but if the recorder itself reconnects and sees only an active session, the execution's identity is unknown. An end or inactive snapshot clears the running clock. A machine without readable, unambiguous evidence has no clock.
