import { Athena } from '@aws-sdk/client-athena';
import AthenaQuery from '@classmethod/athena-query';

const athena = new Athena({});
const athenaQuery = new AthenaQuery(athena, {
  db: process.env.ATHENA_DATABASE || 'waf_logs_database',
  workgroup: process.env.ATHENA_WORKGROUP || 'waf-logs-workgroup',
  catalog: 'AwsDataCatalog',
});

interface QueryEvent {
  query: string;
}

export const handler = async (event: QueryEvent) => {
  try {
    if (!event.query) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: 'Query parameter is required'
        })
      };
    }

    const items = [];

    for await (const item of athenaQuery.query(event.query)) {
      items.push(item);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Athena query executed successfully',
        query: event.query,
        itemCount: items.length,
        items: items
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error executing Athena query',
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};